// The daemon: one unix socket, where browsers (through their native hosts)
// and agents (through `sutradhar call`, or a `sutradhar mcp --in-process`)
// meet, and mcp.sock beside it, where each connection is one MCP session
// served right here (what pranali connects to). systemd may hand it both
// sockets (sutradhar.socket, sutradhar-mcp.socket); see runtime.ts.

import { chmodSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { createPeer, type Frame } from '../../protocol/src/rpc.ts';
import { createLineReader } from '../../protocol/src/framing.ts';
import type { BrowserRouter } from '../../../extension/src/background/router.ts';
import { agentRouter, type AgentRouter } from './agent-router.ts';
import { createMcpServer, draining, SocketTransport } from './mcp.ts';
import { clients, hubRouter } from './hub-router.ts';
import { paths } from './paths.ts';
import { acquireLock, activatedFds, checkSocketPath, leftover, privateDir } from './runtime.ts';
import { D, log, type Conn } from './state.ts';
import { t } from './trpc.ts';
import { settleAll } from './gates.ts';
import { handback, pause, resume, stopAll, takeover } from './control.ts';
import { focusWindow } from './osinput.ts';
import { recorder, startRecording, stopRecording, workingTab } from './record.ts';
import { z } from 'zod';

/** For the `sutradhar` CLI (status, stop, resume). */
const adminRouter = t.router({
  status: t.procedure.query(() => ({
    pid: process.pid, started: D.started, socket: paths.socket,
    browsers: [...D.browsers.values()].map((b) => ({ id: b.id, name: b.hello.name, version: b.hello.version, engine: b.hello.engine, extension: b.hello.extension })),
    sessions: [...D.sessions.values()].map((s) => ({ id: s.id, client: s.client, browser: s.browserId, tabs: [...s.tabs], stopped: s.stopped })),
    gates: [...D.gates.values()].map(({ resolve: _r, ...g }) => g),
    paused: takeover.paused,
    recording: !!recorder.current,
  })),
  stop: t.procedure.mutation(() => stopAll('sutradhar stop')),
  pause: t.procedure.mutation(() => pause('sutradhar pause')),
  handback: t.procedure.mutation(() => handback('sutradhar handback')),
  resume: t.procedure.mutation(() => resume()),
  record: t.procedure.input(z.object({ action: z.enum(['start', 'stop', 'status']), format: z.enum(['gif', 'webm']).optional() })).mutation(async ({ input }) => {
    if (input.action === 'status') return recorder.current ? `recording tab ${recorder.current.tab}, ${recorder.current.frames} frames` : 'not recording';
    if (input.action === 'stop') return (await stopRecording()).path;
    const w = await workingTab();
    if (!w) throw new Error('sutradhar has no tab to record');
    startRecording(w.b, w.tab, input.format ?? 'gif');
    return `recording tab ${w.tab}`;
  }),
  /** Brings the tab sutradhar is working in to the front, so the user can watch. */
  watch: t.procedure.mutation(async () => {
    const recent = [...D.sessions.values()].filter((s) => s.tab !== undefined && s.browserId).sort((a, b) => b.started - a.started)[0];
    for (const b of [...D.browsers.values()]) {
      const tabs = await b.client.tabs.list.query().catch(() => []);
      const tab = (recent?.browserId === b.id && recent.tab) || tabs.find((x: any) => x.group === 'sutra' || x.agent)?.id;
      if (!tab) continue;
      const info = await b.client.tabs.focus.mutate({ tab });
      try { await focusWindow(b.hello.kind, info.title); } catch { /* not on sway */ }
      return `watching ${info.title}`;
    }
    return 'sutradhar has no tab open';
  }),
});

export const rootRouter = t.router({ hub: hubRouter, agent: agentRouter, admin: adminRouter });
export type AdminRouter = typeof adminRouter;
export type RootRouter = typeof rootRouter;

let connSeq = 0;

/** One connection's end in the daemon: frames in, frames out. Agent sockets, browsers and MCP sessions all go through it. */
function attach(send: (f: Frame) => void) {
  const conn: Conn = { id: ++connSeq };
  const peer = createPeer<BrowserRouter>({ router: rootRouter, ctx: () => ({ conn }), send, idPrefix: 'd' });
  clients.set(conn.id, peer.client);
  const gone = () => {
    peer.close('peer disconnected');
    clients.delete(conn.id);
    if (conn.role === 'browser' && conn.browserId) {
      const b = D.browsers.get(conn.browserId);
      if (b && b.client === peer.client) {
        D.browsers.delete(conn.browserId);
        // A gate waiting in a browser that went away can't be answered there.
        for (const g of [...D.gates.values()]) if (g.browserId === conn.browserId) g.resolve('stopped');
        log({ browser: conn.browserId, event: 'disconnected' });
      }
    }
    if (conn.role === 'agent' && conn.sessionId) {
      const s = D.sessions.get(conn.sessionId);
      if (s && s.key) {
        // A CLI session waits for its next call; it ends after 30 idle minutes.
        s.detachedAt = Date.now();
      } else if (s) {
        for (const ac of s.calls) ac.abort();
        D.sessions.delete(conn.sessionId);
        log({ session: conn.sessionId, event: 'session-end' });
      }
    }
  };
  return { conn, handle: (f: Frame) => peer.handle(f), gone };
}

function serve(sock: Socket) {
  const end = attach((f) => { if (!sock.destroyed) sock.write(JSON.stringify(f) + '\n'); });
  sock.setEncoding('utf8');
  sock.on('data', createLineReader((line) => {
    let f: Frame;
    try { f = JSON.parse(line); } catch { return; }
    if ((f as { t: string }).t === 'meta') { end.conn.exe = String((f as unknown as { exe?: string }).exe ?? ''); return; }
    end.handle(f);
  }));
  sock.on('close', end.gone);
  sock.on('error', () => sock.destroy());
}

/** An agent connection inside the daemon: the same router, gates and session rules as one over the socket, without the socket. */
async function localAgent(name: string, cwd?: string, client?: string) {
  let end: ReturnType<typeof attach> | undefined;
  let open = true;
  const peer = createPeer<AgentRouter>({ send: (f) => queueMicrotask(() => { if (open) end!.handle(f); }), idPrefix: 'a', pathPrefix: 'agent.' });
  end = attach((f) => queueMicrotask(() => peer.handle(f)));
  end.conn.cwd = cwd;
  const close = () => { if (!open) return; open = false; peer.close('session ended'); end!.gone(); };
  try { await peer.client.session_start.mutate({ name, client }); } catch (e) { close(); throw e; }
  return { client: peer.client, close };
}

const mcpTransports = new Set<SocketTransport>();
const mainSockets = new Set<Socket>();

const HELLO_TIMEOUT_MS = 5000;

/**
 * mcp.sock: the first line is pranali's hello (pranali/docs/PROTOCOL.md),
 * answered with `{"pranali":1,"ok":true}`; after it, MCP's JSON-RPC, one
 * message per line. Until the next release it may instead be the old
 * sutradhar-mcp preamble, `{"name": "<agent>"}`, which gets no answer. The
 * agent's session starts at its first tool call and ends with the connection.
 */
function serveMcp(sock: Socket) {
  let head = Buffer.alloc(0);
  const timer = setTimeout(() => sock.destroy(), HELLO_TIMEOUT_MS);
  const reply = (r: Record<string, unknown>) => sock.write(JSON.stringify({ pranali: 1, ...r }) + '\n');
  const refuse = (error: string) => { reply({ ok: false, error }); sock.end(); };
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const nl = head.indexOf(10);
    if (nl < 0) { if (head.length > 64 * 1024) sock.destroy(); return; }
    clearTimeout(timer);
    sock.pause();
    sock.off('data', onData);
    let hello: Record<string, unknown>;
    try { hello = JSON.parse(head.subarray(0, nl).toString('utf8')); } catch { sock.destroy(); return; }
    if (!hello || typeof hello !== 'object') { sock.destroy(); return; }
    const isPranali = 'pranali' in hello;
    if (isPranali) {
      if (hello.pranali !== 1) return refuse(`sutradhar speaks pranali protocol 1, not ${JSON.stringify(hello.pranali)}`);
      if (hello.tool !== 'sutradhar') return refuse(`this is sutradhar's socket, not ${JSON.stringify(hello.tool)}'s`);
      if (draining.on) return refuse('sutradhar is restarting');
    }
    const raw = isPranali ? hello.agent : hello.name;
    const name = typeof raw === 'string' && raw ? raw : 'agent';
    const cwd = typeof hello.cwd === 'string' && hello.cwd.startsWith('/') ? hello.cwd : undefined;
    let agent: ReturnType<typeof localAgent> | undefined;
    const server = createMcpServer(async (clientName) => {
      if (!agent) { agent = localAgent(name, cwd, clientName); agent.catch(() => { agent = undefined; }); }
      return (await agent).client;
    });
    const transport = new SocketTransport(sock, head.subarray(nl + 1));
    mcpTransports.add(transport);
    server.onclose = () => { mcpTransports.delete(transport); agent?.then((a) => a.close(), () => {}); };
    if (isPranali) reply({ ok: true });
    server.connect(transport).catch(() => sock.destroy());
  };
  sock.on('data', onData);
  sock.on('end', () => { if (!head.includes(10)) { clearTimeout(timer); sock.destroy(); } });
  sock.on('error', () => sock.destroy());
}

/** Listens on systemd's fd when it passed one, else binds `path` (0600) after making sure nobody listens there. */
async function listenOn(server: Server, fd: number | undefined, path: string): Promise<boolean> {
  if (fd !== undefined) {
    await new Promise<void>((res, rej) => { server.once('error', rej); server.listen({ fd }, () => { server.off('error', rej); res(); }); });
    return false;
  }
  checkSocketPath(path);
  // Only after taking the lock, and only a socket that refuses connections (a dead daemon's) is removed.
  const state = await leftover(path);
  if (state === 'live') throw Object.assign(new Error(`something already listens on ${path} (a systemd socket unit? then: systemctl --user start sutradhar)`), { code: 'BUSY' });
  if (state === 'other') throw new Error(`${path} is in the way and isn't a dead socket; not removing it`);
  if (state === 'dead') unlinkSync(path);
  await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(path, () => { server.off('error', rej); res(); }); });
  chmodSync(path, 0o600);
  return true;
}

/** In-flight work: MCP requests not yet answered, and agent calls (CLI and in-process MCP servers) still running. */
function busy() {
  let n = 0;
  for (const tr of mcpTransports) n += tr.pending.size;
  for (const s of D.sessions.values()) n += s.calls.size;
  return n;
}

export const DRAIN_MS = 20000;

export async function runDaemon() {
  const fds = activatedFds();
  try {
    privateDir(dirname(paths.socket), fds.main === undefined);
    privateDir(dirname(paths.mcpSocket), fds.mcp === undefined);
    privateDir(dirname(paths.lock));
  } catch (e) { console.error(`sutradhar: ${(e as Error).message}`); process.exit(1); }
  const lock = acquireLock(paths.lock);
  if (!lock.ok) {
    console.error(`sutradhar: a daemon is already running (pid ${lock.pid})`);
    // Activated by systemd, failing says so; run by hand, there's nothing wrong.
    process.exit(fds.main !== undefined || fds.mcp !== undefined ? 1 : 0);
  }
  setInterval(() => {
    for (const s of [...D.sessions.values()]) {
      if (s.detachedAt && Date.now() - s.detachedAt > 30 * 60000) {
        D.sessions.delete(s.id);
        log({ session: s.id, event: 'session-end' });
      }
    }
  }, 60000).unref();
  const server = createServer((sock) => { mainSockets.add(sock); sock.on('close', () => mainSockets.delete(sock)); serve(sock); });
  // Half-open: answers written after pranali's half-close (its stdin ended) still arrive.
  const mcpServer = createServer({ allowHalfOpen: true }, serveMcp);
  const bound: string[] = [];
  try {
    if (await listenOn(server, fds.main, paths.socket)) bound.push(paths.socket);
    if (await listenOn(mcpServer, fds.mcp, paths.mcpSocket)) bound.push(paths.mcpSocket);
  } catch (e) {
    console.error(`sutradhar: ${(e as Error).message}`);
    for (const p of bound) try { unlinkSync(p); } catch { /* */ }
    lock.release();
    process.exit((e as { code?: string }).code === 'BUSY' ? 0 : 1);
  }
  log({ event: 'daemon-start', pid: process.pid, activated: Object.keys(fds) });
  console.error(`sutradhar daemon listening on ${paths.socket} (MCP sessions on ${paths.mcpSocket})${fds.main !== undefined || fds.mcp !== undefined ? ' (from systemd)' : ''}`);

  let stopping = false;
  const quit = async () => {
    if (stopping) return;
    stopping = true;
    // 1. No new connections, no new calls (they're told they did not run).
    draining.on = true;
    server.close();
    mcpServer.close();
    // 2. What's running finishes, for up to 20 s.
    const deadline = Date.now() + Number(process.env.SUTRADHAR_DRAIN_MS || DRAIN_MS);
    while (busy() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const left = busy();
    log({ event: 'daemon-stop', pid: process.pid, unfinished: left });
    // 3. Waiting gates can't be answered any more; say goodbye, flushing what was written.
    settleAll('stopped');
    for (const tr of mcpTransports) tr.end();
    for (const s of mainSockets) s.end();
    const flushEnd = Date.now() + 1000;
    while ((mcpTransports.size || mainSockets.size) && Date.now() < flushEnd) await new Promise((r) => setTimeout(r, 20));
    // Only the sockets this daemon bound: systemd's stay, and queue the next connections.
    for (const p of bound) try { unlinkSync(p); } catch { /* */ }
    lock.release();
    process.exit(0);
  };
  process.on('SIGTERM', () => void quit());
  process.on('SIGINT', () => void quit());
}
