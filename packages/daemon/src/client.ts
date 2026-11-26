// Connecting to the daemon. systemd starts it (sutradhar.socket); only
// without those units (a dev checkout, `install --no-service`) does a client
// start one itself, and the daemon's lock keeps that to one.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import type { TRPCClient } from '@trpc/client';
import { createPeer, type Frame } from '../../protocol/src/rpc.ts';
import { createLineReader } from '../../protocol/src/framing.ts';
import type { AgentRouter } from './agent-router.ts';
import { paths } from './paths.ts';
import { privateDir } from './runtime.ts';

/** `sutradhar install` put the socket units in place: systemd owns the daemon's life. */
export const socketActivated = () => existsSync(join(paths.home, '.config/systemd/user/sutradhar.socket'));

export function connectRaw(): Promise<Socket> {
  // Never talk to a socket in a directory someone else could have made.
  try { privateDir(dirname(paths.socket), false); } catch (e) { return Promise.reject(e); }
  return new Promise((resolve, reject) => {
    const s = createConnection(paths.socket);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

/** Connects; without systemd's socket units, starts a daemon in the background if none answers. */
export async function connectOrStart(): Promise<Socket> {
  let why: unknown;
  try { return await connectRaw(); } catch (e) { why = e; }
  if ((why as NodeJS.ErrnoException).code === undefined) throw why; // the directory check, not "no daemon"
  if (socketActivated()) throw new Error(`no sutradhar daemon at ${paths.socket} (systemctl --user start sutradhar.socket)`);
  const self = process.argv[1];
  const child = spawn(process.execPath, [...process.execArgv, self, 'daemon'], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { return await connectRaw(); } catch { /* not yet */ }
  }
  throw new Error(`could not start or reach the sutradhar daemon at ${paths.socket}`);
}

export async function agentClient(name: string, key?: string, cwd?: string, client?: string): Promise<{ client: TRPCClient<AgentRouter>; socket: Socket }> {
  const socket = await connectOrStart();
  const peer = createPeer<AgentRouter>({ send: (f: Frame) => socket.write(JSON.stringify(f) + '\n'), idPrefix: 'a', pathPrefix: 'agent.' });
  socket.setEncoding('utf8');
  socket.on('data', createLineReader((line) => { try { peer.handle(JSON.parse(line)); } catch { /* */ } }));
  socket.on('close', () => peer.close('daemon went away'));
  await peer.client.session_start.mutate({ name, key, cwd, client });
  return { client: peer.client, socket };
}
