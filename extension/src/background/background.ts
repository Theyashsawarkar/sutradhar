// Background entry: keeps the native-messaging line to the daemon open,
// serves browserRouter over it, forwards browser events, and answers the
// panel and the page overlay.

import { createPeer, type Frame } from '../../../packages/protocol/src/rpc.ts';
import { createJoiner, type Wire } from '../../../packages/protocol/src/framing.ts';
import type { HubRouter } from '../../../packages/daemon/src/hub-router.ts';
import type { Hello } from '../../../packages/protocol/src/schemas.ts';
import { browserRouter, group } from './router.ts';
import { ext, isGecko, S } from './state.ts';

const HOST = 'sutradhar';
let port: any = null;
let retry = 500;
let connecting = false;

async function detect(): Promise<Hello> {
  const manifest = ext.runtime.getManifest();
  let kind: Hello['kind'] = 'chromium', name = 'Chromium', version = '';
  if (isGecko) {
    const info = await ext.runtime.getBrowserInfo();
    name = info.name; version = info.version;
    kind = /zen/i.test(info.name) ? 'zen' : /firefox/i.test(info.name) ? 'firefox' : 'other';
  } else {
    const ua = navigator.userAgent;
    version = /Chrome\/([\d.]+)/.exec(ua)?.[1] ?? '';
    const brands: { brand: string }[] = (navigator as any).userAgentData?.brands ?? [];
    if ((navigator as any).brave) { kind = 'brave'; name = 'Brave'; }
    else if (brands.some((b) => b.brand === 'Google Chrome')) { kind = 'chrome'; name = 'Google Chrome'; }
    else if (brands.some((b) => /Edge/.test(b.brand))) { kind = 'edge'; name = 'Microsoft Edge'; }
  }
  let profile = '';
  try {
    const got = await ext.storage.local.get('profileId');
    profile = got.profileId;
    if (!profile) { profile = crypto.randomUUID().slice(0, 8); await ext.storage.local.set({ profileId: profile }); }
  } catch { profile = 'default'; }
  return { kind, name, version, extension: String(manifest.version), engine: isGecko ? 'gecko' : 'chromium', profile };
}

export function connect() {
  if (port || connecting) return;
  connecting = true;
  let p: any;
  try {
    p = ext.runtime.connectNative(HOST);
  } catch (e) {
    connecting = false;
    console.warn('sutradhar: native host missing', e);
    setTimeout(connect, (retry = Math.min(retry * 2, 30000)));
    return;
  }
  port = p;
  const join = createJoiner();
  const peer = createPeer<HubRouter>({ router: browserRouter, send: (f: Frame) => p.postMessage(f), idPrefix: 'x', pathPrefix: 'hub.' });
  p.onMessage.addListener((msg: Wire) => { const f = join(msg); if (f) peer.handle(f); });
  p.onDisconnect.addListener(() => {
    const err = ext.runtime.lastError?.message ?? p.error?.message;
    if (err) console.warn('sutradhar: disconnected:', err);
    peer.close('browser disconnected');
    if (port === p) port = null;
    S.hub = null;
    connecting = false;
    setTimeout(connect, (retry = Math.min(retry * 2, 30000)));
  });
  S.hub = peer.client;
  detect().then(async (hello) => {
    S.hello = hello;
    const cfg = await peer.client.hello.mutate(hello);
    S.risk = cfg.risk; S.osInput = cfg.osInput; S.autoRetry = cfg.autoRetry;
    retry = 500;
    connecting = false;
    setBadge(true);
  }).catch((e) => { console.warn('sutradhar: hello failed', e); connecting = false; try { p.disconnect(); } catch { /* */ } port = null; S.hub = null; setTimeout(connect, (retry = Math.min(retry * 2, 30000))); });
}

function setBadge(on: boolean) {
  const action = ext.action ?? ext.browserAction;
  action?.setBadgeText?.({ text: on ? '' : '!' });
  action?.setBadgeBackgroundColor?.({ color: '#f38ba8' });
}

function event(kind: string, tab: number | undefined, data: unknown) {
  S.hub?.event.mutate({ kind, tab, data } as never).catch(() => {});
}

// ------------------------------------------------------------------ events
ext.tabs.onCreated.addListener((tab: any) => {
  // A page opened by an agent's tab (popup, target=_blank) belongs to that agent too.
  const owner = tab.openerTabId !== undefined ? S.agentTabs.get(tab.openerTabId) : undefined;
  if (owner) { S.agentTabs.set(tab.id, owner); freshPopups.set(tab.id, Date.now()); void group([tab.id], 'sutra'); }
  event('tab-created', tab.id, { url: tab.pendingUrl ?? tab.url, opener: tab.openerTabId, owner });
});
// The tab the user last had in front, per window: given back when an agent's popup steals the front.
const userFront = new Map<number, number>();
ext.tabs.query({ active: true }).then((tabs: { id: number; windowId: number }[]) => {
  for (const t of tabs) if (!userFront.has(t.windowId)) userFront.set(t.windowId, t.id);
}).catch(() => {});
/** Popups an agent's tab just opened: if the browser brings one forward, the user's tab goes back in front. */
const freshPopups = new Map<number, number>();
const prevFront = new Map<number, number>();
ext.tabs.onActivated.addListener((info: { tabId: number; windowId: number }) => {
  if (!S.agentTabs.has(info.tabId)) {
    const was = userFront.get(info.windowId);
    if (was !== undefined && was !== info.tabId) prevFront.set(info.windowId, was);
    userFront.set(info.windowId, info.tabId);
    return;
  }
  const born = freshPopups.get(info.tabId);
  if (born && Date.now() - born < 3000) {
    const back = userFront.get(info.windowId);
    if (back !== undefined && back !== info.tabId) ext.tabs.update(back, { active: true }).catch(() => {});
  }
});
// Popups and target=_blank links opened from an agent's tab (Chrome reports the source here).
ext.webNavigation.onCreatedNavigationTarget?.addListener(async (d: { sourceTabId: number; tabId: number }) => {
  const owner = S.agentTabs.get(d.sourceTabId);
  if (!owner) return;
  freshPopups.set(d.tabId, Date.now());
  void group([d.tabId], 'sutra');
  if (!S.agentTabs.has(d.tabId)) {
    S.agentTabs.set(d.tabId, owner);
    event('tab-created', d.tabId, { opener: d.sourceTabId, owner });
  }
  const tab = await ext.tabs.get(d.tabId).catch(() => null);
  const source = await ext.tabs.get(d.sourceTabId).catch(() => null);
  if (tab?.active && source && !source.active) {
    // The popup may already have been taken for the user's own front tab: then go one further back.
    let back = userFront.get(tab.windowId);
    if (back === d.tabId) { back = prevFront.get(tab.windowId); if (back !== undefined) userFront.set(tab.windowId, back); }
    if (back !== undefined && back !== d.tabId) await ext.tabs.update(back, { active: true }).catch(() => {});
  }
});
ext.tabs.onRemoved.addListener((tabId: number) => {
  S.agentTabs.delete(tabId); S.overlays.delete(tabId); S.net.delete(tabId);
  event('tab-removed', tabId, {});
});
ext.downloads?.onChanged?.addListener((d: any) => {
  if (d.state?.current === 'complete' || d.state?.current === 'interrupted') event('download', undefined, { id: d.id, state: d.state.current });
});
ext.webNavigation.onCommitted.addListener((d: any) => {
  if (d.frameId === 0 && S.agentTabs.has(d.tabId)) event('navigated', d.tabId, { url: d.url });
});

// Network log (metadata only; both engines).
const filter = { urls: ['<all_urls>'] };
const netOf = (tabId: number) => {
  let n = S.net.get(tabId);
  if (!n) { n = { list: [], inflight: new Set() }; S.net.set(tabId, n); }
  return n;
};
ext.webRequest.onBeforeRequest.addListener((d: any) => {
  if (d.tabId < 0) return;
  const n = netOf(d.tabId);
  if (d.type === 'main_frame') { n.list = []; n.inflight.clear(); }
  n.inflight.add(d.requestId);
  n.list.push({ id: d.requestId, method: d.method, url: d.url, type: d.type, start: d.timeStamp });
  if (n.list.length > 1000) n.list.shift();
}, filter);
const finish = (d: any, error?: string) => {
  if (d.tabId < 0) return;
  const n = netOf(d.tabId);
  n.inflight.delete(d.requestId);
  const e = n.list.findLast?.((x: { id: string }) => x.id === d.requestId) ?? [...n.list].reverse().find((x) => x.id === d.requestId);
  if (e) { e.status = d.statusCode; e.error = error; e.ms = Math.round(d.timeStamp - e.start); }
};
ext.webRequest.onCompleted.addListener((d: any) => finish(d), filter);
ext.webRequest.onErrorOccurred.addListener((d: any) => finish(d, d.error), filter);

// ------------------------------------------------------------------ panel, overlay, content
ext.runtime.onMessage.addListener((msg: any, sender: any, reply: (r: unknown) => void) => {
  if (!msg || msg.to === 'content') return false;
  const tabId = sender.tab?.id;
  const run = async () => {
    switch (msg.type) {
      case 'hello-frame':
        return { agent: tabId !== undefined && S.agentTabs.has(tabId), risk: S.risk, overlay: sender.frameId === 0 ? S.overlays.get(tabId) : undefined };
      case 'event':
        event(msg.kind, tabId, msg.data); return true;
      case 'stop':
        if (!S.hub) throw new Error('not connected');
        return S.hub.stop.mutate();
      case 'resume':
        return S.hub?.resume.mutate();
      case 'resolve':
        return S.hub?.resolve.mutate({ id: msg.id, outcome: msg.outcome });
      case 'state': {
        const now: { label: string; host: string; tab: number }[] = [];
        for (const [tab, a] of S.activity) {
          if (Date.now() - a.time > 15000) continue;
          const t = await ext.tabs.get(tab).catch(() => null);
          let host = ''; try { host = new URL(t?.url ?? '').hostname; } catch { /* */ }
          now.push({ label: a.label, host, tab });
        }
        return { connected: !!S.hub, hello: S.hello, now, ...(S.hub ? await S.hub.state.query() : {}) };
      }
      case 'watch': {
        const tabs = [...S.agentTabs.keys()];
        const last = [...S.activity.entries()].sort((x, y) => y[1].time - x[1].time)[0]?.[0] ?? tabs.at(-1);
        if (last === undefined) return false;
        const t = await ext.tabs.update(last, { active: true });
        await ext.windows.update(t.windowId, { focused: true });
        return true;
      }
      case 'policy-set':
        return S.hub?.policySet.mutate(msg.patch);
    }
    return undefined;
  };
  run().then(reply, (e) => reply({ error: String(e?.message ?? e) }));
  return true;
});

ext.commands?.onCommand?.addListener((cmd: string) => {
  if (cmd === 'stop-agents') S.hub?.stop.mutate().catch(() => {});
});

// Keep the line up: on start, and (Chrome MV3) on an alarm in case the worker slept.
ext.runtime.onStartup?.addListener(connect);
ext.runtime.onInstalled?.addListener(connect);
ext.alarms?.create('sutradhar-keepalive', { periodInMinutes: 0.5 });
ext.alarms?.onAlarm.addListener(() => connect());
connect();
