#!/usr/bin/env node
// A minimal pranali (pranali/docs/PROTOCOL.md) for the tests, used when the
// real binary isn't built: `pranali-lite.mjs <tool> [--agent NAME]
// [--fallback CMD ARGS...]`, socket from $PRANALI_SOCKET. It follows the
// spec's state machine: hello, ids tracked, -32001 for calls cut by a
// restart, reconnect (100 ms doubling to 2 s, 60 s rounds) with a replayed
// initialize whose answer is swallowed, a queue of 64, and at stdin EOF a
// half-close with up to 5 s for the remaining answers. It is not the real
// thing: a run against the real pranali is what proves the daemon side.
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';

const argv = process.argv.slice(2);
const tool = argv[0];
const fb = argv.indexOf('--fallback');
const fallback = fb >= 0 ? argv.slice(fb + 1) : null;
const own = fb >= 0 ? argv.slice(0, fb) : argv;
const ai = own.indexOf('--agent');
const agent = ai >= 0 ? own[ai + 1] : process.env.PRANALI_AGENT || 'agent';
const path = process.env.PRANALI_SOCKET;
const ROUND_MS = Number(process.env.PRANALI_ROUND_MS || 60000);
const lost = `${tool} restarted while this call was running: it may or may not have happened. Check (e.g. its log or the sent items) before retrying.`;

const out = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n');
const errorFor = (id) => out({ jsonrpc: '2.0', id, error: { code: -32001, message: lost } });
const key = (id) => JSON.stringify(id);

let sock = null; // connected and ready (hello ok, reinit answered)
let initLine = null;
let initializedLine = null;
const pending = new Map(); // key -> id
const queue = [];
let reinit = 0;
let stdinDone = false;
let reconnecting = false;

/** Connects and does the hello; resolves to { sock, rest } or null. */
function dial() {
  return new Promise((resolve) => {
    const s = createConnection(path);
    let buf = '';
    s.once('error', () => resolve(null));
    s.once('connect', () => {
      s.write(JSON.stringify({ pranali: 1, tool, agent, pid: process.pid, cwd: process.cwd(), env: {} }) + '\n');
    });
    const onData = (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      s.off('data', onData);
      let r; try { r = JSON.parse(buf.slice(0, i)); } catch { r = { ok: false, error: 'bad hello reply' }; }
      if (!r.ok) { process.stderr.write(`pranali: ${tool}: ${r.error}\n`); s.destroy(); resolve(null); return; }
      resolve({ sock: s, rest: buf.slice(i + 1) });
    };
    s.setEncoding('utf8');
    s.on('data', onData);
    s.once('close', () => resolve(null));
  });
}

function wire(s, rest, onClose) {
  let buf = rest;
  const lines = (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { out(line); continue; }
      if (m && typeof m.id === 'string' && m.id.startsWith('pranali-reinit-')) { s.emit('reinit'); continue; }
      if (m && m.id !== undefined && m.id !== null && !m.method) pending.delete(key(m.id));
      out(line);
    }
  };
  s.on('data', lines);
  s.once('close', onClose);
  if (buf) lines('');
}

function send(line, m) {
  if (m && m.method && m.id !== undefined && m.id !== null) pending.set(key(m.id), m.id);
  sock.write(line + '\n');
}

function fromAgent(line) {
  let m; try { m = JSON.parse(line); } catch { m = null; }
  if (m && m.method === 'initialize') initLine = line;
  if (m && m.method === 'notifications/initialized') initializedLine = line;
  if (sock) { send(line, m); return; }
  const isResponse = m && !m.method && m.id !== undefined;
  if (isResponse) return; // to a dead session's request: dropped
  const isRequest = m && m.method && m.id !== undefined && m.id !== null;
  if (queue.length >= 64) { if (isRequest) errorFor(m.id); return; }
  queue.push([line, m]);
  if (!reconnecting) void reconnect();
}

function cut() {
  sock = null;
  for (const id of pending.values()) errorFor(id);
  pending.clear();
  if (stdinDone) process.exit(0);
  void reconnect();
}

async function reconnect() {
  reconnecting = true;
  const end = Date.now() + ROUND_MS;
  let wait = 100;
  while (Date.now() < end) {
    const c = await dial();
    if (c) {
      const ready = await new Promise((resolve) => {
        c.sock.once('reinit', () => resolve(true));
        c.sock.once('close', () => resolve(false));
        wire(c.sock, c.rest, () => { if (sock === c.sock) cut(); });
        if (initLine) {
          const m = JSON.parse(initLine);
          c.sock.write(JSON.stringify({ ...m, id: `pranali-reinit-${++reinit}` }) + '\n');
        } else resolve(true);
      });
      if (ready) {
        if (initializedLine) c.sock.write(initializedLine + '\n');
        sock = c.sock;
        reconnecting = false;
        for (const [line, m] of queue.splice(0)) send(line, m);
        return;
      }
    }
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(wait * 2, 2000);
  }
  reconnecting = false;
  for (const [, m] of queue.splice(0)) if (m && m.method && m.id !== undefined && m.id !== null) errorFor(m.id);
}

const first = await dial();
if (!first) {
  if (!fallback) { process.stderr.write(`pranali: ${tool}: no daemon at ${path}\n`); process.exit(1); }
  const p = spawn(fallback[0], fallback.slice(1), { stdio: 'inherit' });
  p.on('exit', (code) => process.exit(code ?? 1));
} else {
  sock = first.sock;
  wire(sock, first.rest, () => { if (sock === first.sock) cut(); });
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) fromAgent(l); }
  });
  process.stdin.on('end', () => {
    stdinDone = true;
    if (!sock) process.exit(0);
    sock.end(); // half-close: the daemon's answers still come
    sock.once('close', () => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
