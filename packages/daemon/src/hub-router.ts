// hubRouter: what a browser's extension may ask the daemon. Served by the
// daemon; the extension is the client (its calls are prefixed "hub.").

import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { Hello } from '../../protocol/src/schemas.ts';
import { loadConfig, needsApproval, riskConfig, saveConfig } from './config.ts';
import { openGate, settle } from './gates.ts';
import * as os from './osinput.ts';
import { D, log, readLog } from './state.ts';
import { browserProc, t } from './trpc.ts';
import { resume, stopAll } from './control.ts';
import type { BrowserRouter, PageGeometry } from '../../../extension/src/background/router.ts';
import type { TRPCClient } from '@trpc/client';

export const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.html': 'text/html', '.zip': 'application/zip', '.doc': 'application/msword', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Set by daemon.ts: the browser-side client of the connection a call came in on. */
export const clients = new Map<number, TRPCClient<BrowserRouter>>();

export const hubRouter = t.router({
  hello: browserProc.input(Hello).mutation(({ input, ctx }) => {
    if (ctx.conn.role === 'agent') throw new TRPCError({ code: 'FORBIDDEN', message: 'an agent connection cannot become a browser' });
    // Zen tells extensions it is Firefox; the host saw the real executable.
    if (ctx.conn.exe && /zen/i.test(ctx.conn.exe) && input.kind !== 'zen') input = { ...input, kind: 'zen', name: 'Zen' };
    let id: string = input.kind;
    for (let n = 2; [...D.browsers.values()].some((b) => b.id === id && b.hello.profile !== input.profile); n++) id = `${input.kind}-${n}`;
    const client = clients.get(ctx.conn.id)!;
    ctx.conn.role = 'browser';
    ctx.conn.browserId = id;
    D.browsers.set(id, { id, hello: input, client, connectedAt: Date.now(), events: [] });
    log({ browser: id, event: 'connected', name: input.name, version: input.version });
    const cfg = loadConfig();
    return { browserId: id, risk: riskConfig(), osInput: cfg.os_input.enabled, autoRetry: cfg.os_input.auto_retry };
  }),

  event: browserProc.input(z.object({ kind: z.string(), tab: z.number().optional(), data: z.any() })).mutation(({ input, ctx }) => {
    const b = D.browsers.get(ctx.conn.browserId!);
    if (!b) return false;
    b.events.push({ time: Date.now(), ...input });
    if (b.events.length > 300) b.events.shift();
    // Popups and new tabs opened from an agent's tab belong to that agent.
    if (input.kind === 'tab-created' && input.data?.owner) {
      const s = D.sessions.get(input.data.owner);
      if (s && input.tab !== undefined) s.tabs.add(input.tab);
    }
    if (input.kind === 'tab-removed' && input.tab !== undefined) {
      for (const s of D.sessions.values()) if (s.browserId === b.id) { s.tabs.delete(input.tab); if (s.tab === input.tab) s.tab = undefined; }
    }
    return true;
  }),

  /** A step the page judged risky: wait for the user. */
  gate: browserProc.input(z.object({
    tab: z.number(), session: z.string(), url: z.string(), kind: z.enum(['handoff', 'approve']),
    reason: z.string(), what: z.string().optional(), step: z.string(), why: z.string().optional(),
  })).mutation(async ({ input, ctx }) => {
    if (input.kind === 'approve') {
      const rule = needsApproval(input.url, 'approve');
      if (rule === 'allow') return 'approved' as const;
      if (rule === 'deny') return 'denied' as const;
    }
    const title = input.kind === 'handoff' ? handoffTitle(input.reason, input.step) : `${input.step === 'click' ? 'Click' : input.step} ${input.what ?? ''}`.trim();
    return openGate({ kind: input.kind, session: input.session, browserId: ctx.conn.browserId!, tab: input.tab, url: input.url, title, what: input.what, reason: input.reason, why: input.why });
  }),

  /** The user's answer from the overlay card or the extension's panel. */
  resolve: browserProc.input(z.object({ id: z.string(), outcome: z.enum(['done', 'declined', 'approved', 'denied']) })).mutation(({ input }) => {
    const map = { done: 'handoff-done', declined: 'handoff-declined', approved: 'approved', denied: 'denied' } as const;
    return settle(input.id, map[input.outcome]);
  }),

  stop: browserProc.mutation(() => stopAll('the stop button in the browser')),
  resume: browserProc.mutation(() => resume()),

  state: browserProc.query(() => ({
    sessions: [...D.sessions.values()].map((s) => ({ id: s.id, name: s.name, browser: s.browserId, tabs: [...s.tabs], stopped: s.stopped, started: s.started })),
    gates: [...D.gates.values()].map(({ resolve: _r, ...g }) => g),
    browsers: [...D.browsers.values()].map((b) => ({ id: b.id, name: b.hello.name, version: b.hello.version })),
    log: readLog(30),
    config: loadConfig(),
  })),

  policySet: browserProc.input(z.object({ site: z.string(), rule: z.record(z.string(), z.enum(['allow', 'ask', 'deny'])) })).mutation(({ input }) => {
    const c = loadConfig();
    c.sites[input.site] = { ...(c.sites[input.site] ?? {}), ...input.rule };
    saveConfig(c);
    return c.sites[input.site];
  }),

  /** Files for an upload step: read here, sent to the page as bytes. */
  readFiles: browserProc.input(z.object({ paths: z.array(z.string()) })).query(({ input }) => {
    return input.paths.map((p) => {
      if (!p.startsWith('/')) throw new TRPCError({ code: 'BAD_REQUEST', message: `use an absolute path: ${p}` });
      const st = statSync(p);
      if (!st.isFile()) throw new TRPCError({ code: 'BAD_REQUEST', message: `not a file: ${p}` });
      if (st.size > 100 * 1024 * 1024) throw new TRPCError({ code: 'BAD_REQUEST', message: `${p} is over 100 MB` });
      return { name: basename(p), mime: MIME[extname(p).toLowerCase()] ?? 'application/octet-stream', b64: readFileSync(p).toString('base64') };
    });
  }),

  /** Is this tab's browser window the focused window right now (asked of sway)? */
  osFocused: browserProc.input(z.object({ tab: z.number() })).query(async ({ input, ctx }) => {
    if (!loadConfig().os_input.enabled) return false;
    const b = D.browsers.get(ctx.conn.browserId!)!;
    try {
      const g = await b.client.page.geometry.query({ tab: input.tab });
      const w = await os.findWindow(b.hello.kind, g.tabTitle);
      return await os.isFocused(w as never);
    } catch { return false; }
  }),

  /** Real mouse/keyboard for a page step (Firefox/Zen trusted input). */
  osInput: browserProc.input(z.object({
    tab: z.number(), action: z.enum(['click', 'move', 'drag', 'key', 'type', 'focus', 'wheel']),
    x: z.number().optional(), y: z.number().optional(), x2: z.number().optional(), y2: z.number().optional(),
    button: z.string().optional(), count: z.number().optional(), modifiers: z.array(z.string()).optional(),
    keys: z.string().optional(), text: z.string().optional(), direction: z.enum(['up', 'down']).optional(),
  })).mutation(async ({ input, ctx }) => {
    if (!loadConfig().os_input.enabled) throw new TRPCError({ code: 'FORBIDDEN', message: 'OS input is turned off in config.toml' });
    const b = D.browsers.get(ctx.conn.browserId!)!;
    return osAct(b.id, input.tab, { ...input, noFocus: true });
  }),
});

export type HubRouter = typeof hubRouter;

function handoffTitle(reason: string, step: string) {
  if (/password|card|one-time|otp/i.test(reason)) return 'Fill in this field yourself';
  if (/payment|bank|money|buys|order/i.test(reason)) return 'Complete the payment yourself';
  if (/captcha/i.test(reason)) return 'Solve the CAPTCHA';
  if (/account/i.test(reason)) return 'Confirm this account change yourself';
  return `Do this ${step} yourself`;
}

/** One OS-level action in a tab's window; coordinates are the page's viewport pixels. */
export async function osAct(browserId: string, tab: number, a: { noFocus?: boolean; action: string; x?: number; y?: number; x2?: number; y2?: number; button?: string; count?: number; keys?: string; text?: string; direction?: 'up' | 'down'; relative?: 'viewport' | 'window' | 'screen' }): Promise<string> {
  const b = D.browsers.get(browserId);
  if (!b) throw new TRPCError({ code: 'NOT_FOUND', message: `browser ${browserId} is not connected` });
  // Keys for the browser's own dialog (a file picker it opened) go to that dialog.
  if ((a.action === 'key' || a.action === 'type') && (await os.browserDialogFocused(b.hello.kind).catch(() => null))) {
    if (a.action === 'key') { await os.keys(a.keys ?? ''); return `pressed ${a.keys} in the browser's dialog`; }
    await os.typeText(a.text ?? ''); return `typed ${a.text?.length ?? 0} characters into the browser's dialog`;
  }
  const g: PageGeometry | null = await b.client.page.geometry.query({ tab }).catch(() => null);
  const title = g?.tabTitle ?? '';
  // Page steps never take the screen: they only act if the browser already has focus.
  const w = a.noFocus ? await os.findWindow(b.hello.kind, title) : await os.focusWindow(b.hello.kind, title);
  // Never type or click into another window: the browser must really have focus now.
  if (!(await os.isFocused(w as never))) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'the browser window is not in front; real input would land in another window' });
  const scale = await os.outputScale(w as never);
  const at = (x?: number, y?: number): { x: number; y: number } => {
    if (x === undefined || y === undefined) throw new TRPCError({ code: 'BAD_REQUEST', message: 'x and y are needed' });
    if (a.relative === 'screen') return { x, y };
    if (!g) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'cannot read the page geometry; use relative="screen" or "window"' });
    const p = os.toScreen(w as never, g as never, x, y, a.relative === 'window' ? 'window' : 'viewport', scale);
    if (process.env.SUTRADHAR_DEBUG) console.error('osinput', JSON.stringify({ x, y, p, g, rect: (w as any).rect, window_rect: (w as any).window_rect, app: (w as any).app_id, name: (w as any).name }));
    return p;
  };
  switch (a.action) {
    case 'focus': return 'focused';
    case 'move': { const p = at(a.x, a.y); await os.pointer(p); return `pointer at ${p.x},${p.y}`; }
    case 'click': { const p = at(a.x, a.y); await os.click(p, a.button ?? 'left', a.count ?? 1); return `clicked at ${p.x},${p.y}`; }
    case 'drag': { const p = at(a.x, a.y), q = at(a.x2, a.y2); await os.drag(p, q); return 'dragged'; }
    case 'wheel': { const p = at(a.x, a.y); await os.wheel(p, a.direction ?? 'down', a.count ?? 3); return 'scrolled'; }
    case 'key': await os.keys(a.keys ?? ''); return `pressed ${a.keys}`;
    case 'type': await os.typeText(a.text ?? ''); return `typed ${a.text?.length ?? 0} characters`;
  }
  throw new TRPCError({ code: 'BAD_REQUEST', message: `unknown action ${a.action}` });
}
