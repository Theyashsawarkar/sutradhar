// The native-messaging host, at the stdio level: the Rust host
// (crates/sutradhar-host) and the Node one relay the same messages to the
// same bytes, both ways, against a stand-in daemon. Neither starts a daemon,
// and the Rust one refuses a socket directory that isn't private.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { ROOT, sandbox, until } from './harness.mjs';

const RUST = join(ROOT, 'dist', 'sutradhar-host');
const NODE = [process.execPath, join(ROOT, 'dist', 'sutradhar.mjs'), 'host'];
const skip = existsSync(RUST) ? false : 'dist/sutradhar-host not built (no cargo)';

/** What a browser might send: compact and not, odd numbers, escapes, repeated and numeric keys, big strings. */
function browserMessages() {
  const raw = [
    '{"id":"x1","t":"res","result":{"tabs":[1,2,3],"ok":true}}',
    ' { "a" : 1.0 , "b" : [ 1e2 , -0 , 0.1 , 1e21 , 1e-7 , 123456789012345678901 , 1e400 ] } ',
    '{"s":"\\u0041\\/\\u00e9 é \\ud83d\\ude00 \\ud800 \\u0001\\u001f\\b\\f\\n\\r\\t\\"\\\\  "}',
    '{"b":1,"a":2,"b":3,"10":4,"2":5,"01":6,"4294967295":7,"4294967294":8,"__proto__":9}',
    '[]', '"just a string"', '42', 'null', 'true',
    JSON.stringify({ t: 'res', id: 'shot', result: { image: { mime: 'image/png', data: 'A'.repeat(3 * 1024 * 1024) } } }),
    JSON.stringify({ text: 'देवनागरी 漢字 😀 '.repeat(20000) }),
  ];
  // Random values, as a browser's JSON writer would spell them (Chrome writes doubles as "1.0").
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const val = (d) => {
    const r = rnd();
    if (d > 3 || r < 0.3) return [rnd() * 1e6, Math.floor(rnd() * 1e15), -rnd() / 1e9, String.fromCharCode(...Array.from({ length: 8 }, () => Math.floor(rnd() * 0xffff))), true, null][Math.floor(rnd() * 6)];
    if (r < 0.6) return Array.from({ length: Math.floor(rnd() * 4) }, () => val(d + 1));
    return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 4) }, () => [String(Math.floor(rnd() * 20)) + (rnd() < 0.5 ? 'k' : ''), val(d + 1)]));
  };
  for (let i = 0; i < 200; i++) raw.push(JSON.stringify(val(0)).replace(/(?<=[:,[])(-?\d+)(?=[,\]}])/g, (m) => (rnd() < 0.3 ? `${m}.0` : m)));
  return raw.map((s) => Buffer.from(s, 'utf8'));
}

/** What the daemon might send: small frames, blank lines, frames that need parts (a cut surrogate pair, CJK, quotes). */
function daemonLines() {
  const M = 1024 * 1024;
  return [
    JSON.stringify({ t: 'req', id: 'd1', path: 'tabs.list', input: {} }),
    '', '   ', ' ﻿',
    `"${'x'.repeat(M - 2)}"`, // exactly the limit: sent whole
    JSON.stringify({ t: 'req', id: 'd2', input: { code: 'x'.repeat(M - 300) + '😀'.repeat(200) } }),
    JSON.stringify({ t: 'req', id: 'd3', input: { file: 'ab"c\\\n\u0001'.repeat(400000) } }), // ~3 MB of escapes
    JSON.stringify({ t: 'req', id: 'd4', input: { text: '漢字'.repeat(500000) } }), // 3 MB of CJK
    JSON.stringify({ end: true }),
  ];
}

/** Runs one host against a stand-in daemon; returns what each side received. */
async function relay(cmd, sb) {
  const sock = join(sb.dir, 'fake.sock');
  let conn;
  let fromHost = Buffer.alloc(0);
  const server = createServer((c) => { conn = c; c.on('data', (d) => { fromHost = Buffer.concat([fromHost, d]); }); });
  await new Promise((r) => server.listen(sock, r));
  const p = spawn(cmd[0], cmd.slice(1), { env: { ...sb.env, SUTRADHAR_SOCKET: sock }, stdio: ['pipe', 'pipe', 'inherit'] });
  let toBrowser = Buffer.alloc(0);
  p.stdout.on('data', (d) => { toBrowser = Buffer.concat([toBrowser, d]); });
  const exited = new Promise((r) => p.on('exit', (code) => r(code)));
  try {
    const msgs = browserMessages();
    for (const m of msgs) {
      const head = Buffer.alloc(4); head.writeUInt32LE(m.length);
      p.stdin.write(Buffer.concat([head, m]));
    }
    const lines = () => fromHost.toString('utf8').split('\n').length - 1;
    await until(() => lines() === msgs.length + 1, 20000, 'messages at the daemon');
    for (const l of daemonLines()) conn.write(l + '\n');
    await until(() => toBrowser.includes(Buffer.from('{"end":true}')), 20000, 'frames at the browser');
    conn.end(); // the daemon goes: the host ends, 0
    const code = await exited;
    return { fromHost, toBrowser, code };
  } finally { p.kill('SIGKILL'); server.close(); }
}

/** Native messages out of the host's stdout. */
function natives(buf) {
  const out = [];
  for (let i = 0; i < buf.length;) { const n = buf.readUInt32LE(i); out.push(buf.subarray(i + 4, i + 4 + n).toString('utf8')); i += 4 + n; }
  return out;
}

test('the Rust host relays byte for byte what the Node host does', { skip, timeout: 60000 }, async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const rust = await relay([RUST], sb);
  const node = await relay(NODE, sb);
  assert.equal(rust.code, 0);
  assert.equal(node.code, 0);
  // Both name the same parent (this test's node) in the meta line.
  assert.match(rust.fromHost.toString('utf8').split('\n')[0], /^\{"t":"meta","exe":".*node.*"\}$/);
  assert.equal(rust.fromHost.length, node.fromHost.length);
  assert.ok(rust.fromHost.equals(node.fromHost), 'browser → daemon bytes differ');
  assert.ok(rust.toBrowser.equals(node.toBrowser), 'daemon → browser bytes differ');
  // And they are right: every browser message is JSON.stringify(JSON.parse(it)).
  const lines = rust.fromHost.toString('utf8').split('\n').slice(1, -1);
  const msgs = browserMessages();
  lines.forEach((l, i) => assert.equal(l, JSON.stringify(JSON.parse(msgs[i].toString('utf8')))));
  // Big frames went in parts under the browser's 1 MB limit; the extension joins them back.
  const frames = natives(rust.toBrowser);
  assert.ok(frames.some((f) => f.startsWith('{"t":"part"')));
  // Every message fits the browser's 1 MB, escapes, multi-byte text and envelope included.
  const sizes = frames.map((f) => Buffer.byteLength(f));
  assert.ok(sizes.every((n) => n <= 1024 * 1024), JSON.stringify(sizes));
  assert.ok(new Set(frames.filter((f) => f.startsWith('{"t":"part"')).map((f) => JSON.parse(f).pid)).size >= 3);
  const { createJoiner } = await import('../../packages/protocol/src/framing.ts');
  const join2 = createJoiner();
  const whole = frames.map((f) => join2(JSON.parse(f))).filter(Boolean);
  const sent = daemonLines().filter((l) => l.trim());
  assert.deepEqual(whole, sent.map((l) => JSON.parse(l)));
});

test('no daemon: the host says so and exits 1, starting nothing', { skip, timeout: 20000 }, async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  for (const cmd of [[RUST], NODE]) {
    const p = spawn(cmd[0], cmd.slice(1), { env: { ...sb.env, SUTRADHAR_SOCKET: join(sb.dir, 'nobody.sock') }, stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    const code = await new Promise((r) => p.on('exit', r));
    assert.equal(code, 1, cmd[0]);
    assert.match(err, /nobody\.sock/);
    assert.equal(existsSync(join(sb.dir, 'nobody.sock')), false);
  }
});

test('the host refuses a socket directory other users can reach', { skip, timeout: 20000 }, async (t) => {
  const sb = sandbox();
  t.after(() => sb.cleanup());
  const open = join(sb.dir, 'open');
  mkdirSync(open);
  chmodSync(open, 0o755);
  const server = createServer(() => {});
  await new Promise((r) => server.listen(join(open, 'sock'), r));
  t.after(() => server.close());
  for (const cmd of [[RUST], NODE]) {
    const p = spawn(cmd[0], cmd.slice(1), { env: { ...sb.env, SUTRADHAR_SOCKET: join(open, 'sock') }, stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    assert.equal(await new Promise((r) => p.on('exit', r)), 1, cmd[0]);
    assert.match(err, /open to other users/);
  }
});
