// Connecting to the daemon (starting it when it isn't running).

import { spawn } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import type { TRPCClient } from '@trpc/client';
import { createPeer, type Frame } from '../../protocol/src/rpc.ts';
import { createLineReader } from '../../protocol/src/framing.ts';
import type { AgentRouter } from './agent-router.ts';
import { paths } from './paths.ts';

export function connectRaw(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = createConnection(paths.socket);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

/** Connects, starting a daemon in the background if none answers. */
export async function connectOrStart(): Promise<Socket> {
  try { return await connectRaw(); } catch { /* start one */ }
  const self = process.argv[1];
  const child = spawn(process.execPath, [...process.execArgv, self, 'daemon'], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { return await connectRaw(); } catch { /* not yet */ }
  }
  throw new Error(`could not start or reach the sutradhar daemon at ${paths.socket}`);
}

export async function agentClient(name: string, key?: string): Promise<{ client: TRPCClient<AgentRouter>; socket: Socket }> {
  const socket = await connectOrStart();
  const peer = createPeer<AgentRouter>({ send: (f: Frame) => socket.write(JSON.stringify(f) + '\n'), idPrefix: 'a', pathPrefix: 'agent.' });
  socket.setEncoding('utf8');
  socket.on('data', createLineReader((line) => { try { peer.handle(JSON.parse(line)); } catch { /* */ } }));
  socket.on('close', () => peer.close('daemon went away'));
  await peer.client.session_start.mutate({ name, key });
  return { client: peer.client, socket };
}
