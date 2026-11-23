// How frames travel.
//
// - Unix socket (daemon ⇄ host, daemon ⇄ agents): one JSON object per line.
// - Native messaging (host ⇄ browser): 4-byte length + JSON, done by the host.
//   The browser refuses a message over 1 MB from the host, so big frames are
//   cut into `part` frames there and put back together by the extension.

import type { Frame } from './rpc.ts';

export type Part = { t: 'part'; pid: string; i: number; n: number; s: string };
export type Wire = Frame | Part;

/** Native messaging's limit from host to browser is 1 MB; stay well under. */
export const PART_SIZE = 512 * 1024;

let partSeq = 0;
/** Splits one serialized frame into parts when it's too big to send whole. */
export function splitFrame(json: string, size = PART_SIZE): string[] {
  if (json.length <= size) return [json];
  const pid = `p${++partSeq}`;
  const n = Math.ceil(json.length / size);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(JSON.stringify({ t: 'part', pid, i, n, s: json.slice(i * size, (i + 1) * size) } satisfies Part));
  }
  return out;
}

/** Collects `part` frames; returns the whole frame once its last part arrives. */
export function createJoiner() {
  const pending = new Map<string, string[]>();
  return (msg: Wire): Frame | undefined => {
    if (msg.t !== 'part') return msg;
    let parts = pending.get(msg.pid);
    if (!parts) { parts = new Array(msg.n); pending.set(msg.pid, parts); }
    parts[msg.i] = msg.s;
    for (let i = 0; i < msg.n; i++) if (parts[i] === undefined) return undefined;
    pending.delete(msg.pid);
    return JSON.parse(parts.join('')) as Frame;
  };
}

/** Line splitter for NDJSON streams (works on Node Buffers/strings). */
export function createLineReader(onLine: (line: string) => void) {
  let buf = '';
  return (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  };
}
