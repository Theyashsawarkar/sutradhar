// The native-messaging host in Node: started by the browser, a pipe between
// the browser (4-byte length + JSON on stdio) and the daemon (JSON lines on
// the unix socket). Frames too big for the browser's 1 MB limit are cut into
// parts. Normally crates/sutradhar-host does this (bin/sutradhar-host runs
// it when built); this is the fallback, and both behave the same. Neither
// starts a daemon: systemd does (sutradhar.socket), and without it the
// extension tries again later.

import { createLineReader, splitFrame } from '../../protocol/src/framing.ts';
import { readlinkSync } from 'node:fs';
import { connectRaw } from './client.ts';

export async function runHost() {
  const sock = await connectRaw();
  const out = process.stdout;
  // Tell the daemon which program started us: Zen calls itself "Firefox" to extensions.
  let exe = '';
  try { exe = readlinkSync(`/proc/${process.ppid}/exe`); } catch { /* not Linux */ }
  sock.write(JSON.stringify({ t: 'meta', exe }) + '\n');

  const writeNative = (json: string) => {
    const body = Buffer.from(json, 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    out.write(Buffer.concat([head, body]));
  };

  sock.setEncoding('utf8');
  sock.on('data', createLineReader((line) => { for (const part of splitFrame(line)) writeNative(part); }));
  sock.on('close', () => process.exit(0));
  sock.on('error', () => process.exit(1));

  let buf = Buffer.alloc(0);
  process.stdin.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const json = buf.subarray(4, 4 + len).toString('utf8');
      buf = buf.subarray(4 + len);
      // One JSON value per line toward the daemon (JSON.stringify never emits raw newlines).
      sock.write(JSON.stringify(JSON.parse(json)) + '\n');
    }
  });
  process.stdin.on('end', () => { sock.end(); process.exit(0); });
}
