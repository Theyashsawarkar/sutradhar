// browserRouter: what the daemon can ask this browser to do. The daemon is
// the tRPC client here; this extension serves.

import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import { Step } from '../../../packages/protocol/src/schemas.ts';
import { act, showActing } from './act.ts';
import * as cdp from './cdp.ts';
import { content, ext, frames, isGecko, S, sleep, splitRef, waitLoad, type NetEntry } from './state.ts';

const t = initTRPC.create({ isServer: true, allowOutsideOfServer: true });
const p = t.procedure;
const Tab = z.object({ tab: z.number() });

export interface TabInfo {
  id: number; windowId: number; title: string; url: string; active: boolean; pinned: boolean; status: string;
  audible: boolean; muted: boolean; groupId: number; incognito: boolean; agent?: string;
}

async function tabInfo(tab: any): Promise<TabInfo> {
  return {
    id: tab.id, windowId: tab.windowId, title: tab.title ?? '', url: tab.url ?? '', active: !!tab.active,
    pinned: !!tab.pinned, status: tab.status, audible: !!tab.audible, muted: !!tab.mutedInfo?.muted,
    groupId: tab.groupId ?? -1, incognito: !!tab.incognito, agent: S.agentTabs.get(tab.id),
  };
}

const colorNames = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

async function group(tabIds: number[], title: string, color?: string) {
  if (ext.tabs.group && ext.tabGroups) {
    try {
      const existing = (await ext.tabGroups.query({ title })).at?.(0) ?? (await ext.tabGroups.query({ title }))[0];
      const groupId = await ext.tabs.group({ tabIds, ...(existing ? { groupId: existing.id } : {}) });
      await ext.tabGroups.update(groupId, { title, color: colorNames.includes(color ?? '') ? color : 'purple', collapsed: false });
      return groupId;
    } catch { return -1; }
  }
  return -1;
}

async function screenshot(input: { tab: number; full?: boolean; ref?: string; format?: 'png' | 'jpeg'; quality?: number; maxWidth?: number }) {
  const format = input.format ?? 'png';
  let clip: { x: number; y: number; width: number; height: number } | undefined;
  const g = await content(input.tab, 0, 'geometry');
  if (input.ref) {
    const { frameId, ref } = splitRef(input.ref);
    if (frameId !== 0) throw new Error('element screenshots work in the main frame; screenshot the page instead');
    const pr = await content(input.tab, 0, 'prepare', { target: { ref }, kind: 'scroll', force: true });
    const g2 = await content(input.tab, 0, 'geometry');
    clip = { x: pr.rect.x + g2.scrollX, y: pr.rect.y + g2.scrollY, width: Math.max(1, pr.rect.width), height: Math.max(1, pr.rect.height) };
  }
  if (!isGecko) {
    const data = await cdp.screenshot(input.tab, { full: input.full, clip, format, quality: input.quality, maxWidth: input.maxWidth ?? 1600 });
    return { mime: `image/${format}`, data };
  }
  const opts: any = { format, quality: input.quality ?? 85 };
  if (clip) opts.rect = clip;
  else if (input.full) opts.rect = { x: 0, y: 0, width: g.scrollWidth, height: Math.min(g.scrollHeight, 16000) };
  const width = opts.rect?.width ?? g.innerWidth;
  const maxW = input.maxWidth ?? 1600;
  opts.scale = Math.min(1, maxW / (width * g.dpr)) ;
  const url: string = await ext.tabs.captureTab(input.tab, opts);
  return { mime: `image/${format}`, data: url.slice(url.indexOf(',') + 1) };
}

export const browserRouter = t.router({
  info: p.query(() => ({ hello: S.hello, osInput: S.osInput })),

  tabs: t.router({
    list: p.query(async () => Promise.all((await ext.tabs.query({})).map(tabInfo))),
    get: p.input(Tab).query(async ({ input }) => tabInfo(await ext.tabs.get(input.tab))),
    open: p.input(z.object({ url: z.string().optional(), active: z.boolean().optional(), windowId: z.number().optional(),
      group: z.string().optional(), session: z.string().optional(), wait: z.boolean().optional() }))
      .mutation(async ({ input }) => {
        const tab = await ext.tabs.create({ url: input.url || 'about:blank', active: input.active ?? true, windowId: input.windowId });
        if (input.session) S.agentTabs.set(tab.id, input.session);
        if (input.group) await group([tab.id], input.group);
        if (input.url && input.wait !== false) await waitLoad(tab.id);
        return tabInfo(await ext.tabs.get(tab.id));
      }),
    close: p.input(Tab).mutation(async ({ input }) => { await ext.tabs.remove(input.tab); S.agentTabs.delete(input.tab); return true; }),
    focus: p.input(Tab).mutation(async ({ input }) => {
      const tab = await ext.tabs.update(input.tab, { active: true });
      await ext.windows.update(tab.windowId, { focused: true });
      return tabInfo(tab);
    }),
    update: p.input(z.object({ tab: z.number(), pinned: z.boolean().optional(), muted: z.boolean().optional(), zoom: z.number().optional() }))
      .mutation(async ({ input }) => {
        const upd: any = {};
        if (input.pinned !== undefined) upd.pinned = input.pinned;
        if (input.muted !== undefined) upd.muted = input.muted;
        if (Object.keys(upd).length) await ext.tabs.update(input.tab, upd);
        if (input.zoom) await ext.tabs.setZoom(input.tab, input.zoom);
        return tabInfo(await ext.tabs.get(input.tab));
      }),
    duplicate: p.input(Tab).mutation(async ({ input }) => tabInfo(await ext.tabs.duplicate(input.tab))),
    group: p.input(z.object({ tabs: z.array(z.number()), title: z.string(), color: z.string().optional() }))
      .mutation(async ({ input }) => group(input.tabs, input.title, input.color)),
    claim: p.input(z.object({ tab: z.number(), session: z.string() })).mutation(({ input }) => { S.agentTabs.set(input.tab, input.session); return true; }),
    navigate: p.input(z.object({ tab: z.number(), url: z.string().optional(), action: z.enum(['back', 'forward', 'reload']).optional(), timeout: z.number().optional() }))
      .mutation(async ({ input }) => {
        if (input.action === 'back') await ext.tabs.goBack(input.tab);
        else if (input.action === 'forward') await ext.tabs.goForward(input.tab);
        else if (input.action === 'reload') await ext.tabs.reload(input.tab);
        else if (input.url) await ext.tabs.update(input.tab, { url: input.url });
        await sleep(100);
        return tabInfo(await waitLoad(input.tab, input.timeout ?? 20000));
      }),
  }),

  windows: t.router({
    list: p.query(async () => (await ext.windows.getAll({})).map((w: any) => ({ id: w.id, focused: w.focused, state: w.state, width: w.width, height: w.height, incognito: w.incognito }))),
    create: p.input(z.object({ url: z.string().optional(), incognito: z.boolean().optional(), width: z.number().optional(), height: z.number().optional() }))
      .mutation(async ({ input }) => { const w = await ext.windows.create(input); return { id: w.id, tab: w.tabs?.[0]?.id }; }),
    update: p.input(z.object({ windowId: z.number(), width: z.number().optional(), height: z.number().optional(), state: z.enum(['normal', 'minimized', 'maximized', 'fullscreen']).optional(), focused: z.boolean().optional() }))
      .mutation(async ({ input }) => { const { windowId, ...rest } = input; const w = await ext.windows.update(windowId, rest); return { id: w.id, width: w.width, height: w.height, state: w.state }; }),
  }),

  page: t.router({
    snapshot: p.input(z.object({ tab: z.number(), interactive: z.boolean().optional(), viewport: z.boolean().optional(), root: z.string().optional(), maxChars: z.number().optional(), frames: z.boolean().optional() }))
      .query(async ({ input }) => {
        const { tab, root, frames: withFrames = true, ...opts } = input;
        if (root) {
          const { frameId, ref } = splitRef(root);
          const s = await content(tab, frameId, 'snapshot', { ...opts, root: ref });
          return { text: frameId ? prefixRefs(s.text, frameId) : s.text, truncated: s.truncated };
        }
        const top = await content(tab, 0, 'snapshot', opts);
        let text: string = top.text;
        if (withFrames) text = await stitchFrames(tab, 0, text, top.frames, opts);
        return { text, truncated: top.truncated };
      }),
    text: p.input(z.object({ tab: z.number(), maxChars: z.number().optional(), all: z.boolean().optional() }))
      .query(async ({ input }) => content(input.tab, 0, 'text', input)),
    find: p.input(z.object({ tab: z.number(), query: z.string(), role: z.string().optional(), limit: z.number().optional() }))
      .query(async ({ input }) => {
        const out: any[] = [];
        for (const f of await frames(input.tab)) {
          const m = await content<any[]>(input.tab, f.frameId, 'find', input).catch(() => []);
          out.push(...m.map((x) => ({ ...x, ref: f.frameId ? `f${f.frameId}:${x.ref}` : x.ref })));
          if (out.length >= (input.limit ?? 20)) break;
        }
        return out.slice(0, input.limit ?? 20);
      }),
    screenshot: p.input(z.object({ tab: z.number(), full: z.boolean().optional(), ref: z.string().optional(), format: z.enum(['png', 'jpeg']).optional(), quality: z.number().optional(), maxWidth: z.number().optional() }))
      .query(async ({ input }) => screenshot(input)),
    act: p.input(z.object({ tab: z.number(), session: z.string(), why: z.string().optional(), steps: z.array(Step) }))
      .mutation(async ({ input, signal }) => act({ tabId: input.tab, session: input.session, why: input.why, signal }, input.steps)),
    eval: p.input(z.object({ tab: z.number(), code: z.string(), frame: z.number().optional() }))
      .mutation(async ({ input }) => {
        if (!isGecko && !input.frame) return { value: await cdp.evaluate(input.tab, input.code), world: 'page' };
        const wrapped = `(async () => { try { return await (0, eval)(${JSON.stringify(`(async () => (${input.code}))()`)}); } catch (e) { if (!(e instanceof SyntaxError)) throw e; return await (0, eval)(${JSON.stringify(`(async () => { ${input.code} })()`)}); } })()`;
        const r = await ext.tabs.executeScript(input.tab, { code: wrapped, frameId: input.frame ?? 0 });
        return { value: r?.[0] ?? null, world: 'content-script (page globals via window.wrappedJSObject)' };
      }),
    pdf: p.input(z.object({ tab: z.number(), name: z.string().optional() })).mutation(async ({ input }) => {
      if (!isGecko) return { data: await cdp.printPdf(input.tab) };
      const status = await ext.tabs.saveAsPDF({ toFileName: input.name ?? 'page.pdf', showBackgroundColors: true, showBackgroundImages: true });
      return { status };
    }),
    console: p.input(z.object({ tab: z.number(), pattern: z.string().optional(), onlyErrors: z.boolean().optional(), limit: z.number().optional(), clear: z.boolean().optional() }))
      .query(async ({ input }) => {
        const out: any[] = [];
        for (const f of await frames(input.tab)) out.push(...(await content<any[]>(input.tab, f.frameId, 'console', input).catch(() => [])));
        return out.sort((a, b) => a.time - b.time).slice(-(input.limit ?? 100));
      }),
    network: p.input(z.object({ tab: z.number(), pattern: z.string().optional(), limit: z.number().optional(), clear: z.boolean().optional(), onlyErrors: z.boolean().optional() }))
      .query(({ input }) => {
        const n = S.net.get(input.tab);
        if (!n) return [];
        let list = n.list;
        if (input.pattern) { const re = new RegExp(input.pattern, 'i'); list = list.filter((e: NetEntry) => re.test(e.url)); }
        if (input.onlyErrors) list = list.filter((e: NetEntry) => e.error || (e.status ?? 0) >= 400);
        const out = list.slice(-(input.limit ?? 100));
        if (input.clear) n.list = [];
        return out;
      }),
    networkIdle: p.input(z.object({ tab: z.number(), idleMs: z.number().optional(), timeout: z.number().optional() })).query(async ({ input }) => {
      const end = Date.now() + (input.timeout ?? 15000);
      let quietSince = Date.now();
      while (Date.now() < end) {
        const n = S.net.get(input.tab);
        if (n && n.inflight.size > 0) quietSince = Date.now();
        if (Date.now() - quietSince >= (input.idleMs ?? 500)) return true;
        await sleep(100);
      }
      return false;
    }),
    wait: p.input(z.object({ tab: z.number(), ref: z.string().optional(), selector: z.string().optional(), text: z.string().optional(), gone: z.boolean().optional(), timeout: z.number().optional() }))
      .query(async ({ input }) => {
        const { tab, ...rest } = input;
        const fr = rest.ref ? splitRef(rest.ref) : { frameId: 0, ref: undefined };
        return content<boolean>(tab, fr.frameId, 'wait', { ...rest, ref: fr.ref });
      }),
    dialog: p.input(z.object({ tab: z.number(), accept: z.boolean(), text: z.string().optional() })).mutation(async ({ input }) => {
      for (const f of await frames(input.tab)) await content(input.tab, f.frameId, 'dialogAnswer', input).catch(() => {});
      return true;
    }),
    dialogs: p.input(Tab).query(async ({ input }) => content(input.tab, 0, 'dialogs')),
    selection: p.input(Tab).query(async ({ input }) => content(input.tab, 0, 'selection')),
    geometry: p.input(Tab).query(async ({ input }): Promise<PageGeometry> => {
      const g = await content(input.tab, 0, 'geometry');
      const tab = await ext.tabs.get(input.tab);
      const win = await ext.windows.get(tab.windowId);
      return { ...g, windowId: tab.windowId, active: tab.active, windowFocused: win.focused, tabTitle: tab.title };
    }),
  }),

  downloads: t.router({
    list: p.input(z.object({ limit: z.number().optional(), query: z.string().optional() })).query(async ({ input }) => {
      const items = await ext.downloads.search({ orderBy: ['-startTime'], limit: input.limit ?? 20, ...(input.query ? { query: [input.query] } : {}) });
      return items.map(dl);
    }),
    start: p.input(z.object({ url: z.string(), filename: z.string().optional() })).mutation(async ({ input }) => {
      const id = await ext.downloads.download({ url: input.url, filename: input.filename, saveAs: false });
      return { id };
    }),
    wait: p.input(z.object({ id: z.number().optional(), since: z.number().optional(), timeout: z.number().optional() })).query(async ({ input }) => {
      const end = Date.now() + (input.timeout ?? 60000);
      while (Date.now() < end) {
        const q: any = input.id ? { id: input.id } : { orderBy: ['-startTime'], limit: 1 };
        const [d] = await ext.downloads.search(q);
        if (d && (!input.since || Date.parse(d.startTime) >= input.since) && (d.state === 'complete' || d.state === 'interrupted')) return dl(d);
        await sleep(250);
      }
      throw new Error('no download finished in time');
    }),
  }),

  data: t.router({
    bookmarks: p.input(z.object({ query: z.string().optional(), add: z.object({ title: z.string(), url: z.string() }).optional() })).mutation(async ({ input }) => {
      if (input.add) { const b = await ext.bookmarks.create(input.add); return [{ id: b.id, title: b.title, url: b.url }]; }
      const list = input.query ? await ext.bookmarks.search(input.query) : await ext.bookmarks.getRecent(30);
      return list.filter((b: any) => b.url).slice(0, 50).map((b: any) => ({ id: b.id, title: b.title, url: b.url }));
    }),
    history: p.input(z.object({ query: z.string().optional(), limit: z.number().optional(), days: z.number().optional() })).query(async ({ input }) => {
      const list = await ext.history.search({ text: input.query ?? '', maxResults: input.limit ?? 30, startTime: Date.now() - (input.days ?? 30) * 86400000 });
      return list.map((h: any) => ({ title: h.title, url: h.url, lastVisit: h.lastVisitTime, visits: h.visitCount }));
    }),
    cookies: p.input(z.object({ url: z.string() })).query(async ({ input }) => {
      const list = await ext.cookies.getAll({ url: input.url });
      return list.map((c: any) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expires: c.expirationDate }));
    }),
  }),

  ui: t.router({
    show: p.input(z.object({ tab: z.number(), state: z.any(), focus: z.boolean().optional() })).mutation(async ({ input }) => {
      if (input.state?.mode === 'idle') S.overlays.delete(input.tab); else S.overlays.set(input.tab, input.state);
      if (input.focus) {
        const tab = await ext.tabs.update(input.tab, { active: true }).catch(() => null);
        if (tab) await ext.windows.update(tab.windowId, { focused: true, drawAttention: true }).catch(() => {});
      }
      await content(input.tab, 0, 'overlay', input.state).catch(() => {});
      return true;
    }),
    acting: p.input(z.object({ tab: z.number(), session: z.string(), on: z.boolean() })).mutation(async ({ input }) => { await showActing(input.tab, input.session, input.on); return true; }),
    stop: p.mutation(async () => {
      S.stopGen++;
      for (const [tab] of S.overlays) await content(tab, 0, 'overlay', { mode: 'idle' }).catch(() => {});
      for (const tab of S.agentTabs.keys()) for (const f of await frames(tab).catch(() => [])) await content(tab, f.frameId, 'stop').catch(() => {});
      S.overlays.clear();
      if (!isGecko) await cdp.detachAll();
      return true;
    }),
    config: p.input(z.object({ risk: z.any().optional(), osInput: z.boolean().optional(), autoRetry: z.boolean().optional() })).mutation(({ input }) => {
      if (input.risk) S.risk = input.risk;
      if (input.osInput !== undefined) S.osInput = input.osInput;
      if (input.autoRetry !== undefined) S.autoRetry = input.autoRetry;
      return true;
    }),
  }),
});

export type BrowserRouter = typeof browserRouter;

export interface PageGeometry {
  innerWidth: number; innerHeight: number; outerWidth: number; outerHeight: number; dpr: number;
  innerScreenX?: number; innerScreenY?: number; screenX: number; screenY: number; title: string;
  scrollWidth: number; scrollHeight: number; scrollX: number; scrollY: number;
  windowId: number; active: boolean; windowFocused: boolean; tabTitle: string;
}

function dl(d: any) {
  return { id: d.id, url: d.url, filename: d.filename, state: d.state, bytes: d.bytesReceived, total: d.totalBytes, mime: d.mime, error: d.error, started: d.startTime };
}

function prefixRefs(text: string, frameId: number) {
  return text.replace(/\[ref=(e\d+)\]/g, `[ref=f${frameId}:$1]`);
}

/** Replaces each {{frame:N}} placeholder with that child frame's own snapshot. */
async function stitchFrames(tab: number, frameId: number, text: string, slots: { index: number; src: string }[], opts: object, depth = 0): Promise<string> {
  if (!slots.length || depth > 4) return text;
  const all = await frames(tab);
  const kids = all.filter((f) => f.parentFrameId === frameId).sort((a, b) => a.frameId - b.frameId);
  const used = new Set<number>();
  for (const slot of slots) {
    let child = kids.find((k) => !used.has(k.frameId) && k.url === slot.src) ?? kids.find((k) => !used.has(k.frameId) && kids.indexOf(k) === slot.index);
    const marker = `{{frame:${slot.index}}}`;
    const lineStart = text.lastIndexOf('\n', text.indexOf(marker)) + 1;
    const indent = (/^ */.exec(text.slice(lineStart))?.[0].length ?? 0) + 2;
    if (!child) { text = text.replace(marker, '(frame not loaded)'); continue; }
    used.add(child.frameId);
    let inner: string;
    try {
      const s = await content(tab, child.frameId, 'snapshot', opts);
      inner = prefixRefs(await stitchFrames(tab, child.frameId, s.text, s.frames, opts, depth + 1), child.frameId);
    } catch (e) { inner = `- (frame can't be read: ${(e as Error).message})`; }
    const block = inner.split('\n').map((l) => ' '.repeat(indent) + l).join('\n');
    const lineEnd = text.indexOf('\n', text.indexOf(marker));
    text = text.replace(marker, `[frame=${child.frameId}]`);
    const at = lineEnd < 0 ? text.length : text.indexOf('\n', text.indexOf(`[frame=${child.frameId}]`));
    text = at < 0 ? text + '\n' + block : text.slice(0, at) + '\n' + block + text.slice(at);
  }
  return text;
}
