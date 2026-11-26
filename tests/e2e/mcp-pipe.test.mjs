// `sutradhar mcp` through pranali (pranali/docs/PROTOCOL.md): the daemon
// serves each MCP session on mcp.sock after pranali's hello. Runs the real
// pranali when it's built (~/personal/pranali/target/release/pranali, or
// $PRANALI_BIN), else (or with PRANALI_LITE=1) tests/e2e/pranali-lite.mjs, a minimal client written
// from the spec (a real run is then still owed: the output says which ran).
// Also: the daemon's lock (one daemon, a second never unlinks the first's
// sockets), drain on SIGTERM, half-open sockets, socket activation, and the
// runtime directory rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ROOT, sandbox, startDaemon, until } from './harness.mjs';

// PRANALI_LITE=1 runs the stand-in even when the real one is built.
const REAL = process.env.PRANALI_LITE ? undefined : [process.env.PRANALI_BIN, join(homedir(), 'personal/pranali/target/release/pranali')].find((p) => p && existsSync(p));
const LITE = join(ROOT, 'tests', 'e2e', 'pranali-lite.mjs');
console.log(`# pranali: ${REAL ? `the real one (${REAL})` : 'pranali-lite.mjs (spec stand-in; a run with the real pranali is still owed)'}`);
const BUNDLE = join(ROOT, 'dist', 'sutradhar.mjs');
const LOST = /sutradhar restarted while this call was running: it may or may not have happened/;

/** A sandbox whose PATH has `pranali` (real or stand-in), with PRANALI_SOCKET pointing at the test daemon. */
function box(extra = {}) {
  const sb = sandbox();
  const bin = join(sb.dir, 'bin');
  mkdirSync(bin);
  if (REAL) symlinkSync(REAL, join(bin, 'pranali'));
  else writeFileSync(join(bin, 'pranali'), `#!/bin/sh\nexec "${process.execPath}" "${LITE}" "$@"\n`, { mode: 0o755 });
  sb.env = { ...sb.env, PATH: `${bin}:${sb.env.PATH}`, PRANALI_SOCKET: join(sb.dir, 'mcp.sock'), ...extra };
  delete sb.env.XDG_RUNTIME_DIR; // never /run/user/…: everything lives in the sandbox
  return sb;
}

/** An MCP client on a child's stdio. */
function mcp(cmd, args, env) {
  const p = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  const waiting = new Map();
  p.stdout.on('data', (x) => {
    buf += x;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((ok) => { const my = ++id; waiting.set(my, ok); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n'); });
  const exited = new Promise((ok) => p.on('exit', (code) => ok(code)));
  return {
    proc: p, rpc, exited, stderr: () => err,
    async init() {
      const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return r;
    },
    call: (name, args = {}) => rpc('tools/call', { name, arguments: args }),
    close() { p.stdin.end(); return exited; },
  };
}

const sutradharMcp = (sb, name) => mcp(join(ROOT, 'bin', 'sutradhar'), ['mcp', '--name', name], sb.env);
const node = (args, env) => spawnSync(process.execPath, [BUNDLE, ...args], { env, encoding: 'utf8' });

/** Daemons of this sandbox (by their socket, from /proc). */
function daemons(sb) {
  const mine = `SUTRADHAR_SOCKET=${sb.env.SUTRADHAR_SOCKET}`;
  const out = [];
  for (const pid of readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (!argv.includes('daemon') || !argv.some((a) => a.endsWith('sutradhar.mjs'))) continue;
      if (readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(mine)) out.push(+pid);
    } catch { /* gone */ }
  }
  return out;
}
const killAll = (sb) => { for (const p of daemons(sb)) try { process.kill(p, 'SIGKILL'); } catch { /* */ } };

/** A stand-in browser on the daemon's socket: says hello, answers tabs.list after `delay` ms. */
async function fakeBrowser(sb, delay = 0) {
  const s = createConnection(sb.env.SUTRADHAR_SOCKET);
  await new Promise((ok, fail) => { s.once('connect', ok); s.once('error', fail); });
  s.setEncoding('utf8');
  let buf = '';
  const st = { delay };
  s.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const f = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (f.t === 'req') setTimeout(() => { if (!s.destroyed) s.write(JSON.stringify({ t: 'res', id: f.id, data: f.path === 'tabs.list' ? [{ id: 1, title: 'Fixture', url: 'http://example.test/', active: true }] : null }) + '\n'); }, st.delay);
    }
  });
  s.write(JSON.stringify({ t: 'req', id: 'x1', path: 'hub.hello', type: 'mutation', input: { kind: 'chromium', name: 'Fake', version: '1', extension: '0', engine: 'chromium', profile: 'p' } }) + '\n');
  await until(() => /Fake/.test(node(['status'], sb.env).stdout), 5000, 'fake browser');
  return { sock: s, st };
}

/** A raw connection to mcp.sock: lines in, lines out. */
async function raw(path) {
  const s = createConnection({ path, allowHalfOpen: true });
  await new Promise((ok, fail) => { s.once('connect', ok); s.once('error', fail); });
  s.setEncoding('utf8');
  const lines = [];
  let buf = '';
  let ended = false;
  s.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  s.on('end', () => { ended = true; });
  return { s, lines, ended: () => ended, send: (o) => s.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n') };
}
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
const hello = (agent, tool = 'sutradhar') => ({ pranali: 1, tool, agent, pid: process.pid, cwd: '/home/u/project', env: { PATH: '/usr/bin' }, future: 'ignored' });

test('the hello: ok for sutradhar, refused for others, the old preamble still served', { timeout: 30000 }, async (t) => {
  const sb = box();
  const d = startDaemon(sb);
  t.after(() => { d.kill(); killAll(sb); sb.cleanup(); });
  await until(() => existsSync(join(sb.dir, 'mcp.sock')), 5000, 'mcp.sock');
  assert.equal(statSync(join(sb.dir, 'mcp.sock')).mode & 0o777, 0o600);

  const a = await raw(join(sb.dir, 'mcp.sock'));
  a.send(hello('alpha'));
  await until(() => a.lines.length === 1, 3000, 'hello reply');
  assert.deepEqual(a.lines[0], { pranali: 1, ok: true });
  a.send(INIT);
  await until(() => a.lines.length === 2, 3000, 'initialize');
  assert.match(a.lines[1].result.instructions, /untrusted/);
  a.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'log', arguments: {} } });
  await until(() => a.lines.length === 3, 3000, 'log');
  assert.match(a.lines[2].result.content[0].text, /"session":"alpha#\d+"/);
  a.s.destroy();

  const wrong = await raw(join(sb.dir, 'mcp.sock'));
  wrong.send(hello('x', 'narada'));
  await until(() => wrong.lines.length === 1 && wrong.ended(), 3000, 'refusal');
  assert.equal(wrong.lines[0].ok, false);
  assert.match(wrong.lines[0].error, /sutradhar's socket/);

  const v2 = await raw(join(sb.dir, 'mcp.sock'));
  v2.send({ ...hello('x'), pranali: 2 });
  await until(() => v2.lines.length === 1, 3000, 'refusal');
  assert.equal(v2.lines[0].ok, false);

  // A pipe from the last release in a running session: `{"name"}`, no reply, then MCP.
  const old = await raw(join(sb.dir, 'mcp.sock'));
  old.send({ name: 'legacy' });
  old.send(INIT);
  await until(() => old.lines.length === 1, 3000, 'initialize');
  assert.ok(old.lines[0].result);
  old.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'log', arguments: {} } });
  await until(() => old.lines.length === 2, 3000, 'log');
  assert.match(old.lines[1].result.content[0].text, /"session":"legacy#\d+"/);
  old.s.destroy();

  // No hello within 5 s: the daemon hangs up.
  const mute = await raw(join(sb.dir, 'mcp.sock'));
  await until(() => mute.ended() || mute.s.destroyed, 8000, 'hello timeout');
});

test('two agents through pranali: their own sessions, the same tools as the node server', { timeout: 30000 }, async (t) => {
  const sb = box();
  const d = startDaemon(sb);
  await until(() => existsSync(join(sb.dir, 'mcp.sock')), 5000, 'mcp.sock');
  const a = sutradharMcp(sb, 'alpha'); // through the launcher
  const b = mcp(join(ROOT, 'bin', 'sutradhar'), ['mcp'], { ...sb.env, SUTRADHAR_AGENT: 'beta' });
  const old = mcp(process.execPath, [BUNDLE, 'mcp', '--in-process', '--name', 'old'], sb.env);
  t.after(() => { for (const x of [a, b, old]) x.proc.kill(); d.kill(); killAll(sb); sb.cleanup(); });

  const [ia, ib, io] = await Promise.all([a.init(), b.init(), old.init()]);
  // The launcher ran pranali, not node.
  assert.match(readFileSync(`/proc/${a.proc.pid}/cmdline`, 'utf8'), REAL ? /pranali\0sutradhar\0--agent\0alpha/ : /pranali-lite\.mjs\0sutradhar\0--agent\0alpha/);
  assert.deepEqual(ia.result, io.result);
  assert.deepEqual(ib.result, io.result);

  const [ta, tb, to] = await Promise.all([a.rpc('tools/list', {}), b.rpc('tools/list', {}), old.rpc('tools/list', {})]);
  assert.ok(to.result.tools.length > 20);
  assert.deepEqual(ta.result, to.result);
  assert.deepEqual(tb.result, to.result);

  const tabs = await a.call('tabs');
  assert.equal(tabs.result.isError, true);
  assert.match(tabs.result.content[0].text, /No browser is connected/);
  const la = await a.call('log');
  const lb = await b.call('log');
  assert.match(la.result.content[0].text, /"session":"alpha#\d+"/);
  assert.match(lb.result.content[0].text, /"session":"beta#\d+"/);
  assert.doesNotMatch(la.result.content[0].text, /beta#/);
  let status = node(['status'], sb.env).stdout;
  assert.match(status, /alpha#\d+ \(t\)/, 'the MCP client\'s name beside the session'); 
  assert.match(status, /beta#/);

  // One agent leaving ends its session only.
  assert.equal(await a.close(), 0);
  await until(() => !/alpha#/.test(node(['status'], sb.env).stdout), 3000, 'alpha session ends');
  status = node(['status'], sb.env).stdout;
  assert.match(status, /beta#/);
  assert.equal(await b.close(), 0);
  assert.equal(await old.close(), 0, 'the node server leaves at stdin EOF too');
  assert.deepEqual(daemons(sb), [d.proc.pid]);
});

test('a daemon restart mid-call: the call gets -32001, the next works, and nobody starts a daemon (no herd)', { timeout: 40000 }, async (t) => {
  const sb = box();
  const d = startDaemon(sb);
  await until(() => existsSync(join(sb.dir, 'mcp.sock')), 5000, 'mcp.sock');
  const clients = Array.from({ length: 6 }, (_, i) => sutradharMcp(sb, `keeper${i}`));
  let d2;
  t.after(() => { for (const c of clients) c.proc.kill(); d.proc.kill('SIGKILL'); d2?.kill(); killAll(sb); sb.cleanup(); });
  await Promise.all(clients.map((c) => c.init()));
  const c = clients[0];
  assert.match((await c.call('log')).result.content[0].text, /"session":"keeper0#\d+"/);

  // Frozen, the daemon has the call but never answers; then it dies (a crash).
  d.proc.kill('SIGSTOP');
  const inFlight = c.call('log');
  await new Promise((r) => setTimeout(r, 300));
  d.proc.kill('SIGKILL');
  const lost = await inFlight;
  assert.equal(lost.error.code, -32001);
  assert.match(lost.error.message, LOST);

  // Six pipes waiting, and for 4 s nobody starts a daemon: that's systemd's job now.
  await new Promise((r) => setTimeout(r, 4000));
  assert.deepEqual(daemons(sb), []);
  for (const x of clients) assert.equal(x.proc.exitCode, null);

  // The service comes back (as systemd would); the same clients carry on, no new initialize.
  d2 = startDaemon(sb);
  const again = await c.call('log');
  assert.equal(again.result.isError, undefined);
  assert.match(again.result.content[0].text, /"session":"keeper0#\d+"/);
  for (const x of clients.slice(1)) assert.ok((await x.rpc('tools/list', {})).result.tools.some((y) => y.name === 'navigate'));
  assert.deepEqual(daemons(sb), [d2.proc.pid]);
});

test('drain: SIGTERM lets a running call finish, refuses new ones, then exits', { timeout: 40000 }, async (t) => {
  const sb = box();
  const d = startDaemon(sb);
  await until(() => existsSync(join(sb.dir, 'mcp.sock')), 5000, 'mcp.sock');
  const fb = await fakeBrowser(sb, 2500);
  const c = sutradharMcp(sb, 'drainer');
  t.after(() => { fb.sock.destroy(); c.proc.kill(); d.proc.kill('SIGKILL'); killAll(sb); sb.cleanup(); });
  await c.init();
  const slow = c.call('tabs');
  await new Promise((r) => setTimeout(r, 300));
  const exited = new Promise((r) => d.proc.once('exit', (code) => r(code)));
  const t0 = Date.now();
  d.proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  const late = await c.call('log');
  assert.equal(late.error.code, -32002);
  assert.equal(late.error.message, 'sutradhar is restarting; this call was not run, retry it');
  const done = await slow;
  assert.equal(done.result.isError, undefined, JSON.stringify(done));
  assert.match(done.result.content[0].text, /Fixture/);
  assert.equal(await exited, 0);
  assert.ok(Date.now() - t0 >= 2000, 'it waited for the call');
  // It removed the sockets it bound, and its lock.
  assert.equal(existsSync(join(sb.dir, 'mcp.sock')), false);
  assert.equal(existsSync(join(sb.dir, 'sutradhar.sock')), false);
  assert.equal(existsSync(join(sb.dir, 'daemon.lock')), false);
});

test('drain gives up after its limit: the call left over gets -32001', { timeout: 40000 }, async (t) => {
  const sb = box({ SUTRADHAR_DRAIN_MS: '800' });
  const d = startDaemon(sb);
  await until(() => existsSync(join(sb.dir, 'mcp.sock')), 5000, 'mcp.sock');
  const fb = await fakeBrowser(sb, 10000);
  const c = sutradharMcp(sb, 'stuck');
  t.after(() => { fb.sock.destroy(); c.proc.kill(); d.proc.kill('SIGKILL'); killAll(sb); sb.cleanup(); });
  await c.init();
  const slow = c.call('tabs');
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  d.proc.kill('SIGTERM');
  const r = await slow;
  assert.equal(r.error.code, -32001);
  assert.ok(Date.now() - t0 < 5000);
});

test('half-open: answers still arrive after the client closes its side', { timeout: 30000 }, async (t) => {
  const sb = box();
  const d = startDaemon(sb);
  await until(() => existsSync(join(sb.dir, 'mcp.sock')), 5000, 'mcp.sock');
  const fb = await fakeBrowser(sb, 1000);
  t.after(() => { fb.sock.destroy(); d.kill(); killAll(sb); sb.cleanup(); });
  const a = await raw(join(sb.dir, 'mcp.sock'));
  a.send(hello('halfway'));
  a.send(INIT);
  a.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tabs', arguments: {} } });
  a.s.end(); // pranali at stdin EOF
  await until(() => a.ended(), 6000, 'the daemon ends its side');
  assert.equal(a.lines.length, 3);
  assert.match(a.lines[2].result.content[0].text, /Fixture/);

  // And end to end: the agent closes stdin right after asking; it still gets the answer.
  const c = sutradharMcp(sb, 'closer');
  await c.init();
  const answer = c.call('tabs');
  c.proc.stdin.end();
  assert.match((await answer).result.content[0].text, /Fixture/);
  assert.equal(await c.exited, 0);
});

test('one daemon: a second never touches the first one\'s sockets; a dead one\'s lock is taken over', { timeout: 40000 }, async (t) => {
  const sb = box();
  const d = startDaemon(sb);
  t.after(() => { d.proc.kill('SIGKILL'); killAll(sb); sb.cleanup(); });
  await until(() => existsSync(join(sb.dir, 'mcp.sock')), 5000, 'mcp.sock');
  const inode = statSync(join(sb.dir, 'mcp.sock')).ino;
  // Ten at once (what the old pipes' herd did): all leave, the sockets stay the first one's.
  const herd = Array.from({ length: 10 }, () => startDaemon(sb));
  const codes = await Promise.all(herd.map((h) => new Promise((r) => h.proc.once('exit', r))));
  assert.deepEqual(codes, Array(10).fill(0));
  assert.match(herd[0].stderr(), /already running \(pid \d+\)/);
  assert.equal(statSync(join(sb.dir, 'mcp.sock')).ino, inode);
  assert.deepEqual(daemons(sb), [d.proc.pid]);
  const c = sutradharMcp(sb, 'still');
  t.after(() => c.proc.kill());
  await c.init();
  assert.match((await c.call('log')).result.content[0].text, /still#/);

  // A crash leaves its lock and sockets; ten start at once: exactly one takes over.
  const gone = new Promise((r) => d.proc.once('exit', r));
  d.proc.kill('SIGKILL');
  await gone;
  assert.ok(existsSync(join(sb.dir, 'daemon.lock')));
  const next = Array.from({ length: 10 }, () => startDaemon(sb));
  t.after(() => { for (const h of next) h.proc.kill('SIGKILL'); });
  await until(() => daemons(sb).length === 1 && next.filter((h) => h.proc.exitCode === 0).length === 9, 15000, 'one survivor');
  const survivor = next.find((h) => h.proc.exitCode === null);
  assert.equal(+readFileSync(join(sb.dir, 'daemon.lock'), 'utf8'), survivor.proc.pid);
  assert.match((await c.call('log')).result.content[0].text, /still#/);
});

test('socket activation: the daemon takes systemd\'s listeners and leaves them in place', { timeout: 30000, skip: existsSync('/usr/bin/systemd-socket-activate') ? false : 'no systemd-socket-activate' }, async (t) => {
  const sb = box();
  const main = sb.env.SUTRADHAR_SOCKET;
  const mcpSock = join(sb.dir, 'mcp.sock');
  // As sutradhar.socket and sutradhar-mcp.socket would: the daemon starts at the first connection.
  // It passes only the variables named with -E: the sandbox's, never the real home's.
  const pass = ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'SUTRADHAR_SOCKET', 'SUTRADHAR_NOTIFY_CMD', 'SUTRADHAR_NO_OS_INPUT', 'PATH'].map((k) => `-E${k}=${sb.env[k]}`);
  const act = spawn('systemd-socket-activate', ['-l', main, '-l', mcpSock, '--fdname=sutradhar.socket:sutradhar-mcp.socket', ...pass, process.execPath, BUNDLE, 'daemon'], { env: sb.env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  act.stderr.on('data', (x) => { err += x; });
  t.after(() => { act.kill('SIGKILL'); killAll(sb); sb.cleanup(); });
  await until(() => existsSync(mcpSock) && existsSync(main), 5000, 'sockets');
  const c = sutradharMcp(sb, 'activated');
  t.after(() => c.proc.kill());
  await c.init();
  await until(() => /from systemd/.test(err), 5000, 'activated daemon');
  assert.match((await c.call('log')).result.content[0].text, /activated#/);
  assert.match(node(['status'], sb.env).stdout, /activated#/);
  const gone = new Promise((r) => act.once('exit', r));
  act.kill('SIGTERM');
  assert.equal(await gone, 0);
  // Not ours to remove: systemd's sockets stay (the unit queues connections for the next start).
  assert.ok(existsSync(mcpSock) && existsSync(main));
});

test('runtime dir: $XDG_STATE_HOME/sutradhar/run without XDG_RUNTIME_DIR, never /tmp; a shared one is refused', { timeout: 30000 }, async (t) => {
  const sb = box();
  const env = { ...sb.env };
  delete env.SUTRADHAR_SOCKET;
  const d = spawn(process.execPath, [BUNDLE, 'daemon'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => { d.kill('SIGKILL'); sb.cleanup(); });
  const run = join(env.XDG_STATE_HOME, 'sutradhar', 'run');
  await until(() => existsSync(join(run, 'mcp.sock')) && existsSync(join(run, 'sock')), 5000, 'sockets in the state dir');
  assert.equal(statSync(run).mode & 0o777, 0o700);
  assert.match(node(['status'], env).stdout, /running/);
  d.kill();
  await new Promise((r) => d.once('exit', r));

  // Someone opened the directory up: the daemon and the CLI both refuse it.
  chmodSync(run, 0o755);
  const bad = spawnSync(process.execPath, [BUNDLE, 'daemon'], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /open to other users/);
  const st = node(['status'], env);
  assert.match(st.stderr + st.stdout, /open to other users|not running/);
});

test('no daemon at startup: pranali runs the node server in process (--fallback)', { timeout: 30000 }, async (t) => {
  const sb = box();
  // systemd's units are installed here: the node server must not start a daemon either.
  mkdirSync(join(sb.home, '.config/systemd/user'), { recursive: true });
  writeFileSync(join(sb.home, '.config/systemd/user/sutradhar.socket'), '');
  const c = sutradharMcp(sb, 'fallback');
  t.after(() => { c.proc.kill(); killAll(sb); sb.cleanup(); });
  const init = await c.init();
  assert.match(init.result.instructions, /untrusted/);
  await until(() => /sutradhar\.mjs\0mcp\0--in-process\0--name\0fallback/.test(readFileSync(`/proc/${c.proc.pid}/cmdline`, 'utf8')), 3000, 'the node server');
  assert.ok((await c.rpc('tools/list', {})).result.tools.some((x) => x.name === 'navigate'));
  const r = await c.call('log');
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /no sutradhar daemon at .*systemctl --user start sutradhar\.socket/);
  assert.deepEqual(daemons(sb), []);
});
