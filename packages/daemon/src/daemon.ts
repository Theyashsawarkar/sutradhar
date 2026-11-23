// The daemon: one unix socket, where browsers (through their native hosts)
// and agents (through `sutradhar mcp` / `sutradhar call`) meet.

import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { createPeer, type Frame } from '../../protocol/src/rpc.ts';
import { createLineReader } from '../../protocol/src/framing.ts';
import type { BrowserRouter } from '../../../extension/src/background/router.ts';
import { agentRouter } from './agent-router.ts';
import { clients, hubRouter } from './hub-router.ts';
import { paths } from './paths.ts';
import { D, log, type Conn } from './state.ts';
import { t } from './trpc.ts';
import { settleAll } from './gates.ts';
import { resume, stopAll } from './control.ts';

/** For the `sutradhar` CLI (status, stop, resume). */
const adminRouter = t.router({
  status: t.procedure.query(() => ({
    pid: process.pid, started: D.started, socket: paths.socket,
    browsers: [...D.browsers.values()].map((b) => ({ id: b.id, name: b.hello.name, version: b.hello.version, engine: b.hello.engine, extension: b.hello.extension })),
    sessions: [...D.sessions.values()].map((s) => ({ id: s.id, browser: s.browserId, tabs: [...s.tabs], stopped: s.stopped })),
    gates: [...D.gates.values()].map(({ resolve: _r, ...g }) => g),
  })),
  stop: t.procedure.mutation(() => stopAll('sutradhar stop')),
  resume: t.procedure.mutation(() => resume()),
});

export const rootRouter = t.router({ hub: hubRouter, agent: agentRouter, admin: adminRouter });
export type AdminRouter = typeof adminRouter;
export type RootRouter = typeof rootRouter;

let connSeq = 0;

function serve(sock: Socket) {
  const conn: Conn = { id: ++connSeq };
  const send = (f: Frame) => { if (!sock.destroyed) sock.write(JSON.stringify(f) + '\n'); };
  const peer = createPeer<BrowserRouter>({ router: rootRouter, ctx: () => ({ conn }), send, idPrefix: 'd' });
  clients.set(conn.id, peer.client);
  sock.setEncoding('utf8');
  sock.on('data', createLineReader((line) => {
    let f: Frame;
    try { f = JSON.parse(line); } catch { return; }
    if ((f as { t: string }).t === 'meta') { conn.exe = String((f as unknown as { exe?: string }).exe ?? ''); return; }
    peer.handle(f);
  }));
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
      if (s) {
        for (const ac of s.calls) ac.abort();
        if (s.recording) clearInterval(s.recording.timer);
        D.sessions.delete(conn.sessionId);
        log({ session: conn.sessionId, event: 'session-end' });
      }
    }
  };
  sock.on('close', gone);
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
  const server = createServer(serve);
  await new Promise<void>((res) => server.listen(paths.socket, res));
  chmodSync(paths.socket, 0o600);
  log({ event: 'daemon-start', pid: process.pid });
  console.error(`sutradhar daemon listening on ${paths.socket}`);
  const quit = () => {
    settleAll('stopped');
    server.close();
    try { unlinkSync(paths.socket); } catch { /* */ }
    process.exit(0);
  };
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);
}
