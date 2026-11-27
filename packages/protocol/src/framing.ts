// How frames travel.
//
// - Unix socket (daemon ⇄ host, daemon ⇄ agents): one JSON object per line.
// - Native messaging (host ⇄ browser): 4-byte length + JSON, done by the host.
//   The browser refuses a message over 1 MB (UTF-8 bytes) from the host, so
//   big frames are cut into `part` frames there, each under that limit, and
//   put back together by the extension.

import type { Frame } from './rpc.ts';

export type Part = { t: 'part'; pid: string; i: number; n: number; s: string };
export type Wire = Frame | Part;

/** Native messaging's limit from host to browser: 1 MB per message, in UTF-8 bytes. */
export const MAX_NATIVE = 1024 * 1024;
/** Room kept in each part for its envelope (`{"t":"part","pid":…,"i":…,"n":…,"s":"…"}` is under 100 bytes). */
const ENVELOPE = 256;

/** Bytes a code point takes inside a JSON string, escaped as JSON.stringify does. */
function escapedBytes(cp: number) {
  if (cp === 0x22 || cp === 0x5c || cp === 0x08 || cp === 0x0c || cp === 0x0a || cp === 0x0d || cp === 0x09) return 2;
  if (cp < 0x20) return 6;
  if (cp >= 0xd800 && cp <= 0xdfff) return 6; // a lone surrogate (not in text that came as UTF-8)
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

let partSeq = 0;
/**
 * Splits one serialized frame into parts when it's too big to send whole:
 * each part, encoded (envelope and escapes included), is at most `max` UTF-8
 * bytes. Cuts fall between code points. crates/sutradhar-host cuts the same
 * way, to the byte.
 */
export function splitFrame(json: string, max = MAX_NATIVE): string[] {
  if (Buffer.byteLength(json, 'utf8') <= max) return [json];
  const budget = max - ENVELOPE;
  const pieces: string[] = [];
  let start = 0;
  let used = 0;
  let i = 0;
  for (const ch of json) {
    const n = escapedBytes(ch.codePointAt(0)!);
    if (used + n > budget && i > start) { pieces.push(json.slice(start, i)); start = i; used = 0; }
    used += n;
    i += ch.length;
  }
  pieces.push(json.slice(start));
  const pid = `p${++partSeq}`;
  return pieces.map((s, k) => JSON.stringify({ t: 'part', pid, i: k, n: pieces.length, s } satisfies Part));
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
