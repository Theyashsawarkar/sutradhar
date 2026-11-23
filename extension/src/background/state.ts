// Shared background state and the helpers every part uses.

import type { TRPCClient } from '@trpc/client';
import type { HubRouter } from '../../../packages/daemon/src/hub-router.ts';
import type { Hello } from '../../../packages/protocol/src/schemas.ts';
import { DEFAULT_RISK, type RiskConfig } from '../content/risk.ts';
import type { OverlayState } from '../content/overlay.ts';

declare const chrome: any;
export const ext: any = (globalThis as any).browser ?? chrome;
export const isGecko = !!(globalThis as any).browser?.runtime?.getBrowserInfo;

export interface BgState {
  hub: TRPCClient<HubRouter> | null;
  hello: Hello | null;
  risk: RiskConfig;
  osInput: boolean;
  autoRetry: boolean;
  agentTabs: Map<number, string>;
  overlays: Map<number, OverlayState>;
  net: Map<number, { list: NetEntry[]; inflight: Set<string> }>;
  stopGen: number;
}

export const S: BgState = {
  hub: null as TRPCClient<HubRouter> | null,
  hello: null as Hello | null,
  risk: DEFAULT_RISK as RiskConfig,
  osInput: false,
  autoRetry: true,
  /** Tabs an agent is using → session name. */
  agentTabs: new Map<number, string>(),
  overlays: new Map<number, OverlayState>(),
  /** Per-tab network log and in-flight count. */
  net: new Map<number, { list: NetEntry[]; inflight: Set<string> }>(),
  stopGen: 0,
};

export interface NetEntry { id: string; method: string; url: string; type: string; status?: number; error?: string; start: number; ms?: number }

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function hub() {
  if (!S.hub) throw new Error('not connected to the sutradhar daemon');
  return S.hub;
}

/** Ask a frame's content script; injects it if the tab predates the extension. */
export async function content<T = any>(tabId: number, frameId: number, op: string, args: object = {}): Promise<T> {
  const ask = () => ext.tabs.sendMessage(tabId, { to: 'content', op, args }, { frameId });
  let r: any;
  try {
    r = await ask();
  } catch (e) {
    if (!/Receiving end|Could not establish|No matching message handler/i.test(String(e))) throw e;
    await inject(tabId);
    r = await ask();
  }
  if (r === undefined) { await inject(tabId); r = await ask(); }
  if (!r) throw new Error(`frame ${frameId} of tab ${tabId} did not answer (a browser page that extensions can't touch?)`);
  if (r.error) throw new Error(r.error);
  return r.value as T;
}

export async function inject(tabId: number) {
  try {
    if (!isGecko) await ext.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['main-world.js'], world: 'MAIN' }).catch(() => {});
    await ext.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
  } catch (e) {
    throw new Error(`can't script this tab (${String(e).replace(/^Error: /, '')}); browser pages like settings, the extension store or other extensions' pages need os_input`);
  }
}

export async function frames(tabId: number): Promise<{ frameId: number; parentFrameId: number; url: string }[]> {
  return (await ext.webNavigation.getAllFrames({ tabId })) ?? [{ frameId: 0, parentFrameId: -1, url: '' }];
}

/** "f3:e7" → frame 3, ref "e7"; "e7" → frame 0. */
export function splitRef(ref: string): { frameId: number; ref: string } {
  const m = /^f(\d+):(e\d+)$/.exec(ref);
  if (m) return { frameId: +m[1], ref: m[2] };
  return { frameId: 0, ref };
}

export async function waitLoad(tabId: number, timeout = 20000) {
  const end = Date.now() + timeout;
  // Give a navigation a moment to start, then wait for it to finish.
  const t0 = Date.now();
  while (Date.now() < end) {
    const tab = await ext.tabs.get(tabId);
    if (tab.status === 'complete' && Date.now() - t0 > 150) return tab;
    await sleep(100);
  }
  return ext.tabs.get(tabId);
}
