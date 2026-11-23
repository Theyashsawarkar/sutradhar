// The daemon's memory: connected browsers, agent sessions, waiting gates.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TRPCClient } from '@trpc/client';
import type { BrowserRouter } from '../../../extension/src/background/router.ts';
import type { Hello } from '../../../packages/protocol/src/schemas.ts';
import { logFile } from './paths.ts';

export interface BrowserConn {
  id: string;
  hello: Hello;
  client: TRPCClient<BrowserRouter>;
  connectedAt: number;
  events: { time: number; kind: string; tab?: number; data: any }[];
}

export interface Session {
  id: string;
  name: string;
  browserId?: string;
  tab?: number;
  tabs: Set<number>;
  started: number;
  /** Set when the user pressed Stop after this session started. */
  stopped: boolean;
  calls: Set<AbortController>;
  recording?: { dir: string; timer: ReturnType<typeof setInterval>; tab: number; frames: number; format: string };
}

export type Outcome = 'handoff-done' | 'handoff-declined' | 'approved' | 'denied' | 'timeout' | 'stopped';

export interface Gate {
  id: string;
  kind: 'handoff' | 'approve';
  session: string;
  browserId: string;
  tab: number;
  url: string;
  title: string;
  what?: string;
  reason?: string;
  why?: string;
  created: number;
  resolve: (o: Outcome) => void;
}

export interface Conn {
  id: number;
  role?: 'browser' | 'agent';
  browserId?: string;
  sessionId?: string;
  /** The browser executable, as the native host saw its parent. */
  exe?: string;
}

export const D = {
  browsers: new Map<string, BrowserConn>(),
  sessions: new Map<string, Session>(),
  gates: new Map<string, Gate>(),
  seq: 0,
  started: Date.now(),
};

export function log(entry: Record<string, unknown>) {
  try {
    mkdirSync(dirname(logFile()), { recursive: true });
    appendFileSync(logFile(), JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* logging never breaks an action */ }
}

export function readLog(limit = 50, session?: string): any[] {
  try {
    const lines = readFileSync(logFile(), 'utf8').trim().split('\n');
    const out: any[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try { const e = JSON.parse(lines[i]); if (!session || e.session === session) out.push(e); } catch { /* */ }
    }
    return out.reverse();
  } catch { return []; }
}
