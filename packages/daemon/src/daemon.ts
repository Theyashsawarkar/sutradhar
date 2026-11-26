// The daemon: one unix socket, where browsers (through their native hosts)
// and agents (through `sutradhar call`, or a `sutradhar mcp` in its own
// process) meet, and mcp.sock beside it, where each connection is one MCP
// session served right here (what the sutradhar-mcp pipe connects to).

import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { createPeer, type Frame } from '../../protocol/src/rpc.ts';
import { createLineReader } from '../../protocol/src/framing.ts';
import type { BrowserRouter } from '../../../extension/src/background/router.ts';
import { agentRouter, type AgentRouter } from './agent-router.ts';
import { createMcpServer, SocketTransport } from './mcp.ts';
import { clients, hubRouter } from './hub-router.ts';
import { paths } from './paths.ts';
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
    sessions: [...D.sessions.values()].map((s) => ({ id: s.id, browser: s.browserId, tabs: [...s.tabs], stopped: s.stopped })),
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
async function localAgent(name: string) {
  let end: ReturnType<typeof attach> | undefined;
  let open = true;
  const peer = createPeer<AgentRouter>({ send: (f) => queueMicrotask(() => { if (open) end!.handle(f); }), idPrefix: 'a', pathPrefix: 'agent.' });
  end = attach((f) => queueMicrotask(() => peer.handle(f)));
  const close = () => { if (!open) return; open = false; peer.close('session ended'); end!.gone(); };
  try { await peer.client.session_start.mutate({ name }); } catch (e) { close(); throw e; }
  return { client: peer.client, close };
}

/**
 * mcp.sock: the first line is a preamble, `{"name": "<agent>"}`; after it,
 * MCP's JSON-RPC, one message per line. The agent's session starts at its
 * first tool call and ends when the connection closes, as in its own process.
 */
function serveMcp(sock: Socket) {
  let head = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const nl = head.indexOf(10);
    if (nl < 0) { if (head.length > 64 * 1024) sock.destroy(); return; }
    sock.pause();
    sock.off('data', onData);
    let pre: { name?: unknown };
    try { pre = JSON.parse(head.subarray(0, nl).toString('utf8')); } catch { sock.destroy(); return; }
    const name = typeof pre?.name === 'string' && pre.name ? pre.name : 'agent';
    let agent: ReturnType<typeof localAgent> | undefined;
    const server = createMcpServer(async () => {
      if (!agent) { agent = localAgent(name); agent.catch(() => { agent = undefined; }); }
      return (await agent).client;
    });
    server.onclose = () => { agent?.then((a) => a.close(), () => {}); };
    server.connect(new SocketTransport(sock, head.subarray(nl + 1))).catch(() => sock.destroy());
  };
  sock.on('data', onData);
  sock.on('error', () => sock.destroy());
}

export async function runDaemon() {
  mkdirSync(dirname(paths.socket), { recursive: true, mode: 0o700 });
  if (existsSync(paths.socket)) {
    // Another daemon alive? Then leave it be.
    const alive = await new Promise<boolean>((res) => {
      const c = createConnection(paths.socket);
      c.on('connect', () => { c.destroy(); res(true); });
      c.on('error', () => res(false));
    });
    if (alive) { console.error(`sutradhar: a daemon is already running on ${paths.socket}`); process.exit(0); }
    unlinkSync(paths.socket);
  }
  mkdirSync(dirname(paths.mcpSocket), { recursive: true, mode: 0o700 });
  // Left by a daemon that died: nothing listens there now (the check above found no live daemon).
  if (existsSync(paths.mcpSocket)) unlinkSync(paths.mcpSocket);
  setInterval(() => {
    for (const s of [...D.sessions.values()]) {
      if (s.detachedAt && Date.now() - s.detachedAt > 30 * 60000) {
        D.sessions.delete(s.id);
        log({ session: s.id, event: 'session-end' });
      }
    }
  }, 60000).unref();
  const server = createServer(serve);
  await new Promise<void>((res) => server.listen(paths.socket, res));
  chmodSync(paths.socket, 0o600);
  const mcpServer = createServer(serveMcp);
  await new Promise<void>((res) => mcpServer.listen(paths.mcpSocket, res));
  chmodSync(paths.mcpSocket, 0o600);
  log({ event: 'daemon-start', pid: process.pid });
  console.error(`sutradhar daemon listening on ${paths.socket} (MCP sessions on ${paths.mcpSocket})`);
  const quit = () => {
    settleAll('stopped');
    server.close();
    mcpServer.close();
    try { unlinkSync(paths.socket); } catch { /* */ }
    try { unlinkSync(paths.mcpSocket); } catch { /* */ }
    process.exit(0);
  };
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);
}
