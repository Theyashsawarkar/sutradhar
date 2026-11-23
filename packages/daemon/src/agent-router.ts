// agentRouter: the API agents use. Every procedure here is also an MCP tool
// (same name, same zod input, `description` from its meta).

import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { Step } from '../../protocol/src/schemas.ts';
import { needsApproval } from './config.ts';
import { openGate } from './gates.ts';
import { MIME, osAct } from './hub-router.ts';
import { paths } from './paths.ts';
import { D, log, readLog, type BrowserConn, type Session } from './state.ts';
import { agentProc, t, type Ctx } from './trpc.ts';

const run = promisify(execFile);
/** The tab group sutradhar works in: the strings the sūtradhāra holds. The user works outside it. */
export const SUTRA = 'sutra';
const TabArg = { tab: z.number().optional().describe('Tab id (from tabs); defaults to the tab this session used last') };

// ------------------------------------------------------------------ sessions
export function sessionFor(ctx: Ctx, name?: string): Session {
  let s = ctx.conn.sessionId ? D.sessions.get(ctx.conn.sessionId) : undefined;
  if (!s) {
    const base = (name || 'agent').replace(/[^\w.-]/g, '').slice(0, 24) || 'agent';
    const id = `${base}#${++D.seq}`;
    s = { id, name: base, tabs: new Set(), started: Date.now(), stopped: false, calls: new Set() };
    D.sessions.set(id, s);
    ctx.conn.sessionId = id;
    log({ session: id, event: 'session-start' });
  }
  if (s.stopped) throw new TRPCError({ code: 'FORBIDDEN', message: 'The user pressed Stop. Ask them before you carry on; they can resume from the extension panel or with `sutradhar resume`.' });
  return s;
}

function browserFor(s: Session): BrowserConn {
  if (s.browserId) {
    const b = D.browsers.get(s.browserId);
    if (b) return b;
    s.browserId = undefined; s.tab = undefined; s.tabs.clear();
  }
  const all = [...D.browsers.values()].sort((a, b) => b.connectedAt - a.connectedAt);
  if (!all.length) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'No browser is connected. Open Chrome, Firefox or Zen with the sutradhar extension (see `sutradhar doctor`).' });
  // Prefer the user's default browser kind if several are connected.
  const pref = process.env.SUTRADHAR_BROWSER;
  const b = (pref && all.find((x) => x.id === pref || x.hello.kind === pref)) || all[0];
  s.browserId = b.id;
  return b;
}

async function tabFor(s: Session, tab?: number, open = true): Promise<{ b: BrowserConn; tab: number }> {
  const b = browserFor(s);
  if (tab !== undefined) {
    if (!s.tabs.has(tab)) {
      const info = await b.client.tabs.get.query({ tab }).catch(() => null);
      if (!info) throw new TRPCError({ code: 'NOT_FOUND', message: `tab ${tab} doesn't exist; call tabs` });
      // The extension remembers this session's tabs across a daemon restart: take them back.
      if (info.agent === s.id) { s.tabs.add(tab); s.tab = tab; return { b, tab }; }
      if (info.agent && info.agent !== s.id) throw new TRPCError({ code: 'FORBIDDEN', message: `tab ${tab} belongs to another agent (${info.agent})` });
      throw new TRPCError({ code: 'FORBIDDEN', message: `tab ${tab} is the user's, not yours. Open your own with tab_open, or ask to borrow it with tab_attach.` });
    }
    s.tab = tab;
    return { b, tab };
  }
  if (s.tab !== undefined && s.tabs.has(s.tab)) return { b, tab: s.tab };
  if (!open) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'no tab yet: open one with tab_open or navigate' });
  // Its own tab, in the background: the user keeps working in theirs.
  const info = await b.client.tabs.open.mutate({ url: 'about:blank', session: s.id, group: SUTRA, active: false, wait: false });
  s.tabs.add(info.id); s.tab = info.id;
  return { b, tab: info.id };
}

/** Runs `fn` with an AbortSignal that Stop can fire, and logs the call. */
async function call<T>(s: Session, tool: string, detail: Record<string, unknown>, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  s.calls.add(ac);
  const started = Date.now();
  try {
    const r = await fn(ac.signal);
    log({ session: s.id, tool, ...detail, ok: true, ms: Date.now() - started });
    return r;
  } catch (e) {
    log({ session: s.id, tool, ...detail, ok: false, error: (e as Error).message, ms: Date.now() - started });
    if (ac.signal.aborted) throw new TRPCError({ code: 'CLIENT_CLOSED_REQUEST', message: 'stopped by the user' });
    throw e;
  } finally { s.calls.delete(ac); }
}

async function approve(s: Session, b: BrowserConn, tab: number, title: string, what: string, why?: string, kind: 'approve' | 'eval' | 'cookies' = 'approve') {
  const info = await b.client.tabs.get.query({ tab }).catch(() => ({ url: '' }));
  const rule = needsApproval(info.url, kind);
  if (rule === 'allow') return;
  if (rule === 'deny') throw new TRPCError({ code: 'FORBIDDEN', message: 'the user turned this off for this site' });
  const o = await openGate({ kind: 'approve', session: s.id, browserId: b.id, tab, url: info.url, title, what, why });
  if (o !== 'approved') throw new TRPCError({ code: 'FORBIDDEN', message: o === 'timeout' ? 'the user did not answer in time' : o === 'stopped' ? 'the user pressed Stop' : 'the user said no' });
}

const tabLine = (x: any, s: Session) => `${x.id}${x.active ? '*' : ''}  ${x.agent === s.id ? `[yours${x.group ? ' · ' + x.group : ''}] ` : x.agent ? `[${x.agent}] ` : ''}${x.title || '(untitled)'} — ${x.url}`;

// ------------------------------------------------------------------ the tools
export const agentRouter = t.router({
  session_start: agentProc.meta({ description: 'internal: name this session' })
    .input(z.object({ name: z.string(), key: z.string().optional() })).mutation(({ ctx, input }) => {
      if (ctx.conn.sessionId) { const s = D.sessions.get(ctx.conn.sessionId); if (s) return s.id; }
      // A keyed session (the CLI's) outlives its connection: the next call with the same key picks it up, tabs and all.
      if (input.key) {
        const old = [...D.sessions.values()].find((x) => x.key === input.key);
        if (old) { ctx.conn.sessionId = old.id; old.detachedAt = undefined; return old.id; }
      }
      const s = sessionFor(ctx, input.name);
      if (input.key) s.key = input.key;
      return s.id;
    }),

  browsers: agentProc.meta({ description: 'List connected browsers (Chrome, Firefox, Zen…) and pick the one this session uses.' })
    .input(z.object({ use: z.string().optional().describe('Browser id to use from now on, e.g. "zen" or "chrome"') }))
    .mutation(({ ctx, input }) => {
      const s = sessionFor(ctx);
      if (input.use) {
        const b = D.browsers.get(input.use) ?? [...D.browsers.values()].find((x) => x.hello.kind === input.use);
        if (!b) throw new TRPCError({ code: 'NOT_FOUND', message: `no connected browser "${input.use}"` });
        if (s.browserId !== b.id) { s.browserId = b.id; s.tab = undefined; s.tabs.clear(); }
      }
      const cur = D.browsers.size ? browserFor(s).id : undefined;
      return [...D.browsers.values()].map((b) => `${b.id === cur ? '* ' : '  '}${b.id}: ${b.hello.name} ${b.hello.version} (${b.hello.engine})`).join('\n') || 'No browser is connected.';
    }),

  tabs: agentProc.meta({ description: 'List the tabs in the current browser. [yours] marks tabs this session may use; * is the active tab.', untrusted: true })
    .input(z.object({})).query(async ({ ctx }) => {
      const s = sessionFor(ctx);
      const b = browserFor(s);
      const list = await b.client.tabs.list.query();
      return list.map((x: any) => tabLine(x, s)).join('\n') + `\n\ncurrent tab: ${s.tab ?? 'none (tab_open or navigate makes one)'}`;
    }),

  tab_open: agentProc.meta({ description: "Open a new tab in the \"sutra\" tab group (sutradhar's own), in the background (the user keeps working in theirs), and make it the current tab.", untrusted: true })
    .input(z.object({ url: z.string().optional(), front: z.boolean().optional().describe('Bring it to the front (only if the user asked to watch)') }))
    .mutation(async ({ ctx, input }) => {
      const s = sessionFor(ctx); const b = browserFor(s);
      return call(s, 'tab_open', { url: input.url }, async () => {
        const info = await b.client.tabs.open.mutate({ url: input.url, session: s.id, group: SUTRA, active: !!input.front });
        s.tabs.add(info.id); s.tab = info.id;
        return tabLine(info, s);
      });
    }),

  tab_close: agentProc.meta({ description: 'Close one of your tabs.' }).input(z.object({ tab: z.number() })).mutation(async ({ ctx, input }) => {
    const s = sessionFor(ctx); const { b, tab } = await tabFor(s, input.tab);
    await call(s, 'tab_close', { tab }, () => b.client.tabs.close.mutate({ tab }));
    s.tabs.delete(tab); if (s.tab === tab) s.tab = [...s.tabs].at(-1);
    return `closed tab ${tab}`;
  }),

  tab_focus: agentProc.meta({ description: 'Bring one of your tabs to the front. Only when the user asks to watch or take over: sutradhar works in background tabs while the user uses theirs.' }).input(z.object({ tab: z.number() })).mutation(async ({ ctx, input }) => {
    const s = sessionFor(ctx); const { b, tab } = await tabFor(s, input.tab);
    const info = await b.client.tabs.focus.mutate({ tab });
    return tabLine(info, s);
  }),

  tab_update: agentProc.meta({ description: 'Pin, mute, zoom or duplicate one of your tabs.' })
    .input(z.object({ ...TabArg, pinned: z.boolean().optional(), muted: z.boolean().optional(), zoom: z.number().optional().describe('1 = 100%'), duplicate: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const s = sessionFor(ctx); const { b, tab } = await tabFor(s, input.tab);
      if (input.duplicate) { const d = await b.client.tabs.duplicate.mutate({ tab }); s.tabs.add(d.id); await b.client.tabs.claim.mutate({ tab: d.id, session: s.id }); return tabLine(d, s); }
      return tabLine(await b.client.tabs.update.mutate({ tab, pinned: input.pinned, muted: input.muted, zoom: input.zoom }), s);
    }),

  tab_attach: agentProc.meta({ description: "Ask the user to let you use one of their own tabs (they approve it first)." })
    .input(z.object({ tab: z.number(), why: z.string().describe('What you want to do in it, in the user\'s words') }))
    .mutation(async ({ ctx, input }) => {
      const s = sessionFor(ctx); const b = browserFor(s);
      const info = await b.client.tabs.get.query({ tab: input.tab });
      await approve(s, b, input.tab, `Let ${s.name} use this tab`, info.title, input.why);
      s.tabs.add(input.tab); s.tab = input.tab;
      await b.client.tabs.claim.mutate({ tab: input.tab, session: s.id });
      return `tab ${input.tab} is yours to use: ${info.title}`;
    }),

  navigate: agentProc.meta({ description: 'Go to a URL (or back/forward/reload) in the current tab and wait for it to load. Opens a tab if you have none.', untrusted: true })
    .input(z.object({ ...TabArg, url: z.string().optional(), action: z.enum(['back', 'forward', 'reload']).optional() }))
    .mutation(async ({ ctx, input }) => {
      const s = sessionFor(ctx); const { b, tab } = await tabFor(s, input.tab);
      let url = input.url;
      if (url && !/^[a-z][\w+.-]*:/i.test(url)) url = 'https://' + url;
      return call(s, 'navigate', { tab, url, action: input.action }, async () => {
        await b.client.ui.acting.mutate({ tab, session: s.id, on: true }).catch(() => {});
        try {
          const info = await b.client.tabs.navigate.mutate({ tab, url, action: input.action });
          return `${info.status === 'complete' ? 'loaded' : 'still loading'}: ${info.title} — ${info.url}`;
        } finally { await b.client.ui.acting.mutate({ tab, session: s.id, on: false }).catch(() => {}); }
      });
    }),

  snapshot: agentProc.meta({ description: 'Read the page as a tree of roles, names and states, with a ref (e12, f3:e7 in frames) for everything you can act on. Use refs in act. Includes iframes and shadow DOM. Password, card and OTP values are never shown.', untrusted: true })
    .input(z.object({ ...TabArg, interactive: z.boolean().optional().describe('Only controls, no text'), viewport: z.boolean().optional().describe('Only what is on screen'), root: z.string().optional().describe('Ref to zoom into'), maxChars: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      const s = sessionFor(ctx); const { b, tab } = await tabFor(s, input.tab);
      const r = await call(s, 'snapshot', { tab }, () => b.client.page.snapshot.query({ ...input, tab }));
      return r.text;
    }),

  page_text: agentProc.meta({ description: "The page's main content as Markdown (articles, docs, results). Use snapshot to act.", untrusted: true })
    .input(z.object({ ...TabArg, maxChars: z.number().optional(), all: z.boolean().optional().describe('Whole page, not just the main content') }))
    .query(async ({ ctx, input }) => {
      const s = sessionFor(ctx); const { b, tab } = await tabFor(s, input.tab);
      return (await call(s, 'page_text', { tab }, () => b.client.page.text.query({ ...input, tab }))).markdown;
    }),

  screenshot: agentProc.meta({ description: 'Screenshot the visible page, the full page, or one element (ref).' })
    .input(z.object({ ...TabArg, full: z.boolean().optional(), ref: z.string().optional(), format: z.enum(['png', 'jpeg']).optional(), save: z.string().optional().describe('Also save to this path') }))
    .query(async ({ ctx, input }) => {
      const s = sessionFor(ctx); const { b, tab } = await tabFor(s, input.tab);
      const img = await call(s, 'screenshot', { tab }, () => b.client.page.screenshot.query({ tab, full: input.full, ref: input.ref, format: input.format ?? 'jpeg', quality: 80 }));
      if (input.save) writeFileSync(input.save, Buffer.from(img.data, 'base64'));
      if (s.recording?.tab === tab) frame(s, img.data);
      return { image: img, note: input.save ? `saved to ${input.save}` : undefined };
    }),

  find: agentProc.meta({ description: 'Find elements by visible text, accessible name, role or CSS selector. Returns refs for act.', untrusted: true })
    .input(z.object({ ...TabArg, query: z.string(), role: z.string().optional().describe('button, link, textbox, checkbox…'), limit: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      const s = sessionFor(ctx); const { b, tab } = await tabFor(s, input.tab);
      const m = await call(s, 'find', { tab, query: input.query }, () => b.client.page.find.query({ ...input, tab }));
      return m.length ? m.map((x: any) => `${x.ref}  ${x.what}${x.text ? `  "${x.text}"` : ''}`).join('\n') : 'nothing matched';
    }),

  act: agentProc.meta({ description: `Do things in the page, in order: click, hover, move, type, press, select, check, fill, clear, focus, scroll, drag, upload, wait. Target elements by ref (from snapshot/find), selector, text, or x/y. Stops at the first failure.
Payments, card/bank details, passwords, OTPs, CAPTCHAs and buy/pay/transfer/delete-account buttons are never done by you: the user is notified, does it themselves, and you get the result (gate=handoff-done). Send/publish/delete need the user's Allow first.`, untrusted: true })
    .input(z.object({ ...TabArg, steps: z.array(Step).min(1), why: z.string().optional().describe("What the user asked for, in their words (shown when a step needs them)"), snapshot: z.boolean().optional().describe('Return a fresh snapshot after') }))
    .mutation(async ({ ctx, input }) => {
      const s = sessionFor(ctx); const { b, tab } = await tabFor(s, input.tab);
      const r = await call(s, 'act', { tab, steps: input.steps.map((x) => x.do).join(',') }, (signal) =>
        b.client.page.act.mutate({ tab, session: s.id, why: input.why, steps: input.steps }, { signal }));
      if (s.recording?.tab === tab) void b.client.page.screenshot.query({ tab, format: 'jpeg', quality: 70 }).then((i) => frame(s, i.data)).catch(() => {});
      const lines = r.results.map((x: any, i: number) => `${i + 1}. ${x.do}: ${x.ok ? 'ok' : 'FAILED'}${x.gate ? ` [${x.gate}]` : ''}${x.note ? ' — ' + x.note : ''}${x.error ? ' — ' + x.error : ''}`);
      if (r.results.length < input.steps.length) lines.push(`(${input.steps.length - r.results.length} step(s) not run)`);
      for (const d of r.dialogs ?? []) lines.push(`dialog: ${d.kind} "${d.message}" → ${d.answer}`);
      lines.push(`now: ${r.title} — ${r.url}${r.status === 'loading' ? ' (loading)' : ''}`);
      if (input.snapshot) lines.push('', (await b.client.page.snapshot.query({ tab, viewport: true })).text);
      return lines.join('\n');
    }),

  dialog: agentProc.meta({ description: "Set how the page's next alert/confirm/prompt is answered (they're answered automatically so they never freeze the page: confirm/prompt default to Cancel). Then repeat the step that opened it." })
    .input(z.object({ ...TabArg, accept: z.boolean(), text: z.string().optional().describe('Text for a prompt()') }))
    .mutation(async ({ ctx, input }) => {
      const s = sessionFor(ctx); const { b, tab } = await tabFor(s, input.tab);
      await b.client.page.dialog.mutate({ tab, accept: input.accept, text: input.text });
      const seen = await b.client.page.dialogs.query({ tab });
      return `the next dialog will be answered ${input.accept ? 'OK' : 'Cancel'}${seen.length ? `\nrecent: ${seen.slice(-3).map((d: any) => `${d.kind} "${d.message}" → ${d.answer}`).join('; ')}` : ''}`;
    }),

  eval_js: agentProc.meta({ description: "Run JavaScript in the page and get the JSON result (asks the user first unless they allowed it for the site). On Chrome it runs in the page; on Firefox/Zen in the content script (page globals through window.wrappedJSObject).", untrusted: true })
    .input(z.object({ ...TabArg, code: z.string(), why: z.string().describe('Why, in the user\'s words') }))
    .mutation(async ({ ctx, input }) => {
      const s = sessionFor(ctx); const { b, tab } = await tabFor(s, input.tab);
      const info = await b.client.tabs.get.query({ tab });
      await approve(s, b, tab, 'Run JavaScript in this page', input.code.slice(0, 300), input.why, 'eval');
      const r = await call(s, 'eval_js', { tab, code: input.code.slice(0, 200) }, () => b.client.page.eval.mutate({ tab, code: input.code }));
      return JSON.stringify(r.value, null, 2) ?? 'undefined';
    }),

  console_read: agentProc.meta({ description: "The page's console messages and errors (captured from the start of each page).", untrusted: true })
    .input(z.object({ ...TabArg, pattern: z.string().optional().describe('Regex filter'), onlyErrors: z.boolean().optional(), limit: z.number().optional(), clear: z.boolean().optional() }))
    .query(async ({ ctx, input }) => {
      const s = sessionFor(ctx); const { b, tab } = await tabFor(s, input.tab);
      const list = await b.client.page.console.query({ ...input, tab });
      return list.map((c: any) => `[${c.level}] ${c.text}`).join('\n') || 'no console messages';
    }),

  network_read: agentProc.meta({ description: 'Requests the page made since it loaded: method, URL, status, type, time.', untrusted: true })
    .input(z.object({ ...TabArg, pattern: z.string().optional().describe('Regex on the URL'), onlyErrors: z.boolean().optional(), limit: z.number().optional(), clear: z.boolean().optional() }))
    .query(async ({ ctx, input }) => {
      const s = sessionFor(ctx); const { b, tab } = await tabFor(s, input.tab);
      const list = await b.client.page.network.query({ ...input, tab });
      return list.map((n: any) => `${n.method} ${n.status ?? (n.error ? 'ERR' : '…')} ${n.type} ${n.url}${n.error ? ` (${n.error})` : ''}${n.ms !== undefined ? ` ${n.ms}ms` : ''}`).join('\n') || 'no requests';
    }),

  wait_for: agentProc.meta({ description: 'Wait for text, an element (ref/selector), its disappearance, a URL, the network going quiet, or a download.' })
    .input(z.object({ ...TabArg, text: z.string().optional(), selector: z.string().optional(), ref: z.string().optional(), gone: z.boolean().optional(),
      url: z.string().optional(), networkIdle: z.boolean().optional(), download: z.boolean().optional(), timeout: z.number().optional().describe('ms, default 15000') }))
    .query(async ({ ctx, input }) => {
      const s = sessionFor(ctx); const { b, tab } = await tabFor(s, input.tab);
      const timeout = input.timeout ?? 15000;
      return call(s, 'wait_for', { tab }, async () => {
        if (input.download) { const d = await b.client.downloads.wait.query({ since: Date.now() - 2000, timeout }); return `download ${d.state}: ${d.filename}`; }
        if (input.networkIdle) return (await b.client.page.networkIdle.query({ tab, timeout })) ? 'network is quiet' : 'network still busy';
        if (input.url) {
          const end = Date.now() + timeout;
          while (Date.now() < end) { const i = await b.client.tabs.get.query({ tab }); if (i.url.includes(input.url) && i.status === 'complete') return `at ${i.url}`; await new Promise((r) => setTimeout(r, 200)); }
          throw new TRPCError({ code: 'TIMEOUT', message: `URL never contained ${input.url}` });
        }
        const ok = await b.client.page.wait.query({ tab, text: input.text, selector: input.selector, ref: input.ref, gone: input.gone, timeout });
        if (!ok) throw new TRPCError({ code: 'TIMEOUT', message: 'timed out' });
        return input.gone ? 'gone' : 'there';
      });
    }),

  downloads: agentProc.meta({ description: 'Downloads: list recent ones, start one from a URL, wait for one to finish, or read a finished file.', untrusted: true })
    .input(z.object({ action: z.enum(['list', 'start', 'wait', 'read']), url: z.string().optional(), id: z.number().optional(), path: z.string().optional(), timeout: z.number().optional() }))
    .mutation(async ({ ctx, input }) => {
      const s = sessionFor(ctx); const b = browserFor(s);
      const fmt = (d: any) => `${d.id} ${d.state} ${d.filename || d.url} ${d.bytes ?? ''}${d.error ? ' ' + d.error : ''}`;
      if (input.action === 'list') return (await b.client.downloads.list.query({ limit: 20 })).map(fmt).join('\n') || 'no downloads';
      if (input.action === 'start') { if (!input.url) throw new TRPCError({ code: 'BAD_REQUEST', message: 'url needed' }); const r = await b.client.downloads.start.mutate({ url: input.url }); return `started download ${r.id}`; }
      if (input.action === 'wait') return fmt(await b.client.downloads.wait.query({ id: input.id, timeout: input.timeout }));
      let path = input.path;
      if (!path) { const [d] = await b.client.downloads.list.query({ limit: 1 }); path = input.id ? (await b.client.downloads.list.query({ limit: 50 })).find((x: any) => x.id === input.id)?.filename : d?.filename; }
      if (!path) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such download' });
      const st = statSync(path);
      const mime = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
      if (mime.startsWith('text/') || mime === 'application/json') return `${path} (${st.size} bytes)\n\n` + readFileSync(path, 'utf8').slice(0, 200000);
      if (mime === 'application/pdf') { try { const { stdout } = await run('pdftotext', ['-layout', path, '-'], { maxBuffer: 20e6 }); return `${path} (PDF, ${st.size} bytes)\n\n${stdout.slice(0, 200000)}`; } catch { /* no pdftotext */ } }
      return `${path} (${mime}, ${st.size} bytes); binary, not shown`;
    }),

  page_pdf: agentProc.meta({ description: 'Save the page as a PDF; returns the path.' }).input(z.object({ ...TabArg, path: z.string().optional() })).mutation(async ({ ctx, input }) => {
    const s = sessionFor(ctx); const { b, tab } = await tabFor(s, input.tab);
    const info = await b.client.tabs.get.query({ tab });
    const name = (info.title || 'page').replace(/[^\w.-]+/g, '-').slice(0, 60) + '.pdf';
    const r = await b.client.page.pdf.mutate({ tab, name });
    if ('data' in r && r.data) {
      const path = input.path ?? join(paths.downloads, name);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, Buffer.from(r.data, 'base64'));
      return `saved ${path}`;
    }
    return `Firefox/Zen show a save dialog for PDFs: ${(r as any).status}`;
  }),

  window: agentProc.meta({ description: 'Browser windows: list, open a new one (optionally private), resize, maximize, fullscreen.' })
    .input(z.object({ action: z.enum(['list', 'create', 'resize', 'state']), url: z.string().optional(), incognito: z.boolean().optional(), width: z.number().optional(), height: z.number().optional(), state: z.enum(['normal', 'minimized', 'maximized', 'fullscreen']).optional(), ...TabArg }))
    .mutation(async ({ ctx, input }) => {
      const s = sessionFor(ctx); const b = browserFor(s);
      if (input.action === 'list') return (await b.client.windows.list.query()).map((w: any) => `${w.id}${w.focused ? '*' : ''} ${w.width}x${w.height} ${w.state}${w.incognito ? ' private' : ''}`).join('\n');
      if (input.action === 'create') {
        const w = await b.client.windows.create.mutate({ url: input.url, incognito: input.incognito, width: input.width, height: input.height });
        if (w.tab !== undefined) { s.tabs.add(w.tab); s.tab = w.tab; await b.client.tabs.claim.mutate({ tab: w.tab, session: s.id }); }
        return `window ${w.id} with tab ${w.tab}`;
      }
      const { tab } = await tabFor(s, input.tab);
      const info = await b.client.tabs.get.query({ tab });
      const w = await b.client.windows.update.mutate({ windowId: info.windowId, width: input.width, height: input.height, state: input.action === 'state' ? input.state : input.width ? 'normal' : undefined });
      return `window ${w.id}: ${w.width}x${w.height} ${w.state}`;
    }),

  clipboard: agentProc.meta({ description: "The system clipboard: set it, or read it (asks the user first)." })
    .input(z.object({ action: z.enum(['get', 'set']), text: z.string().optional(), why: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const s = sessionFor(ctx);
      if (input.action === 'set') {
        await new Promise<void>((res, rej) => { const c = spawn('wl-copy', [], { stdio: ['pipe', 'ignore', 'ignore'] }); c.on('error', rej); c.on('close', () => res()); c.stdin.end(input.text ?? ''); });
        log({ session: s.id, tool: 'clipboard', action: 'set' });
        return 'copied';
      }
      const b = browserFor(s); const { tab } = await tabFor(s);
      await approve(s, b, tab, 'Read your clipboard', '', input.why);
      const { stdout } = await run('wl-paste', ['--no-newline']).catch(() => ({ stdout: '' }));
      return stdout;
    }),

  bookmarks: agentProc.meta({ description: 'Search bookmarks (or list recent ones), or add one.', untrusted: true })
    .input(z.object({ query: z.string().optional(), add: z.object({ title: z.string(), url: z.string() }).optional() }))
    .mutation(async ({ ctx, input }) => {
      const s = sessionFor(ctx); const b = browserFor(s);
      return (await b.client.data.bookmarks.mutate(input)).map((x: any) => `${x.title} — ${x.url}`).join('\n') || 'none';
    }),

  history: agentProc.meta({ description: 'Search browsing history.', untrusted: true })
    .input(z.object({ query: z.string().optional(), days: z.number().optional(), limit: z.number().optional() })).query(async ({ ctx, input }) => {
      const s = sessionFor(ctx); const b = browserFor(s);
      return (await b.client.data.history.query(input)).map((h: any) => `${new Date(h.lastVisit).toISOString().slice(0, 16)} ${h.title} — ${h.url}`).join('\n') || 'none';
    }),

  cookies: agentProc.meta({ description: "Read a site's cookies (asks the user first unless allowed for the site).", untrusted: true })
    .input(z.object({ url: z.string(), why: z.string() })).mutation(async ({ ctx, input }) => {
      const s = sessionFor(ctx); const b = browserFor(s); const { tab } = await tabFor(s);
      await approve(s, b, tab, `Read cookies of ${input.url}`, '', input.why, 'cookies');
      return JSON.stringify(await b.client.data.cookies.query({ url: input.url }), null, 1);
    }),

  record: agentProc.meta({ description: 'Record what happens in the current tab as a GIF or WebM: start, then stop (returns the file path).' })
    .input(z.object({ action: z.enum(['start', 'stop']), format: z.enum(['gif', 'webm']).optional(), path: z.string().optional(), ...TabArg }))
    .mutation(async ({ ctx, input }) => {
      const s = sessionFor(ctx); const { b, tab } = await tabFor(s, input.tab);
      if (input.action === 'start') {
        if (s.recording) clearInterval(s.recording.timer);
        const dir = mkdtempSync(join(tmpdir(), 'sutradhar-rec-'));
        const rec = { dir, tab, frames: 0, format: input.format ?? 'gif', timer: setInterval(() => {
          b.client.page.screenshot.query({ tab, format: 'jpeg', quality: 70, maxWidth: 1000 }).then((i) => frame(s, i.data)).catch(() => {});
        }, 700) };
        s.recording = rec;
        return 'recording';
      }
      const rec = s.recording;
      if (!rec) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'not recording' });
      clearInterval(rec.timer); s.recording = undefined;
      if (!rec.frames) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'no frames were captured' });
      const out = input.path ?? join(paths.downloads, `recording-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${rec.format}`);
      mkdirSync(join(out, '..'), { recursive: true });
      const scale = 'scale=trunc(min(iw\\,1000)/2)*2:-2';
      const args = rec.format === 'gif'
        ? ['-y', '-framerate', '2', '-start_number', '1', '-i', join(rec.dir, '%05d.jpg'), '-vf', `${scale},split[a][b];[a]palettegen[p];[b][p]paletteuse`, out]
        : ['-y', '-framerate', '2', '-start_number', '1', '-i', join(rec.dir, '%05d.jpg'), '-vf', scale, '-c:v', 'libvpx-vp9', '-b:v', '1M', out];
      await run('ffmpeg', args, { maxBuffer: 10e6 });
      rmSync(rec.dir, { recursive: true, force: true });
      return `saved ${out} (${rec.frames} frames)`;
    }),

  handoff: agentProc.meta({ description: "Hand a step to the user and wait: logging in, a CAPTCHA, a 2FA code, a payment, anything only they should do. They're notified at once, do it in the tab, press Done; you get done / declined / timeout." })
    .input(z.object({ ...TabArg, task: z.string().describe('What the user should do, short: "Log in to your bank"'), why: z.string().optional(), timeoutMinutes: z.number().optional() }))
    .mutation(async ({ ctx, input }) => {
      const s = sessionFor(ctx); const { b, tab } = await tabFor(s, input.tab);
      const info = await b.client.tabs.get.query({ tab });
      const o = await call(s, 'handoff', { tab, task: input.task }, () => openGate({ kind: 'handoff', session: s.id, browserId: b.id, tab, url: info.url, title: input.task, why: input.why },
        input.timeoutMinutes ? input.timeoutMinutes * 60000 : undefined));
      const after = await b.client.tabs.get.query({ tab }).catch(() => info);
      return `${o === 'handoff-done' ? 'done' : o === 'handoff-declined' ? 'declined: stop and ask the user' : o}; now at ${after.title} — ${after.url}`;
    }),

  os_input: agentProc.meta({ description: "Use the real mouse and keyboard on the browser window (asks the user first): for the browser's own menus, address bar, permission prompts, file pickers, or pages that ignore normal input. x/y are viewport pixels unless relative is 'window' or 'screen'." })
    .input(z.object({ ...TabArg, why: z.string(), steps: z.array(z.object({
      do: z.enum(['click', 'move', 'drag', 'key', 'type', 'wheel']), x: z.number().optional(), y: z.number().optional(), x2: z.number().optional(), y2: z.number().optional(),
      button: z.enum(['left', 'right', 'middle']).optional(), count: z.number().optional(), keys: z.string().optional().describe('e.g. "Control+l", "Return"'), text: z.string().optional(),
      direction: z.enum(['up', 'down']).optional(), relative: z.enum(['viewport', 'window', 'screen']).optional(),
    })).min(1) }))
    .mutation(async ({ ctx, input }) => {
      const s = sessionFor(ctx); const { b, tab } = await tabFor(s, input.tab);
      await approve(s, b, tab, 'Use your mouse and keyboard', input.steps.map((x) => x.do + (x.keys ? ` ${x.keys}` : x.text ? ` "${x.text.slice(0, 30)}"` : x.x !== undefined ? ` ${x.x},${x.y}` : '')).join(', '), input.why);
      const out: string[] = [];
      for (const st of input.steps) out.push(await call(s, 'os_input', { tab, do: st.do }, () => osAct(b.id, tab, { ...st, action: st.do })));
      return out.join('\n');
    }),

  log: agentProc.meta({ description: "This session's recent actions (or everyone's with all=true)." })
    .input(z.object({ limit: z.number().optional(), all: z.boolean().optional() })).query(({ ctx, input }) => {
      const s = sessionFor(ctx);
      return readLog(input.limit ?? 30, input.all ? undefined : s.id).map((e) => JSON.stringify(e)).join('\n');
    }),
});

export type AgentRouter = typeof agentRouter;

function frame(s: Session, b64: string) {
  const rec = s.recording;
  if (!rec) return;
  rec.frames++;
  writeFileSync(join(rec.dir, String(rec.frames).padStart(5, '0') + '.jpg'), Buffer.from(b64, 'base64'));
}
