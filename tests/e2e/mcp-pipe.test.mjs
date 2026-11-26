// `sutradhar mcp` as the small Rust pipe: the daemon serves each MCP session
// on mcp.sock. Same tools, names and answers as the old in-process server;
// starts a daemon when none runs; falls back to node when it can't reach one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, sandbox, startDaemon, until } from './harness.mjs';

const PIPE = join(ROOT, 'dist', 'sutradhar-mcp');
const skip = existsSync(PIPE) ? false : 'dist/sutradhar-mcp not built (no cargo)';

/** An MCP client on a child's stdio. */
function mcp(cmd, args, env) {
  const p = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
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
    proc: p, rpc, exited,
    async init() {
      const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return r;
    },
    call: (name, args = {}) => rpc('tools/call', { name, arguments: args }),
    close() { p.stdin.end(); return exited; },
  };
}

const node = (args, env) => spawnSync(process.execPath, [join(ROOT, 'dist', 'sutradhar.mjs'), ...args], { env, encoding: 'utf8' });

test('two agents through the pipe: one daemon, their own sessions, the old tools', { skip, timeout: 30000 }, async (t) => {
  const sb = sandbox();
  const d = startDaemon(sb);
  await until(() => existsSync(join(sb.dir, 'mcp.sock')), 5000, 'mcp.sock');
  const a = mcp(join(ROOT, 'bin', 'sutradhar'), ['mcp', '--name', 'alpha'], sb.env); // through the launcher
  const b = mcp(PIPE, [], { ...sb.env, SUTRADHAR_AGENT: 'beta' });
  const old = mcp(process.execPath, [join(ROOT, 'dist', 'sutradhar.mjs'), 'mcp', '--name', 'old'], sb.env);
  t.after(() => { for (const x of [a, b, old]) x.proc.kill(); d.kill(); sb.cleanup(); });

  const [ia, ib, io] = await Promise.all([a.init(), b.init(), old.init()]);
  // The launcher ran the pipe, not node.
  assert.match(readFileSync(`/proc/${a.proc.pid}/cmdline`, 'utf8'), /sutradhar-mcp/);
  assert.deepEqual(ia.result, io.result);
  assert.deepEqual(ib.result, io.result);
  assert.match(ia.result.instructions, /untrusted/);

  const [ta, tb, to] = await Promise.all([a.rpc('tools/list', {}), b.rpc('tools/list', {}), old.rpc('tools/list', {})]);
  assert.ok(to.result.tools.length > 20);
  assert.deepEqual(ta.result, to.result);
  assert.deepEqual(tb.result, to.result);

  // Calls reach the daemon's router, gates and errors and all.
  const tabs = await a.call('tabs');
  assert.equal(tabs.result.isError, true);
  assert.match(tabs.result.content[0].text, /No browser is connected/);
  const la = await a.call('log');
  const lb = await b.call('log');
  assert.match(la.result.content[0].text, /"session":"alpha#\d+"/);
  assert.match(lb.result.content[0].text, /"session":"beta#\d+"/);
  assert.doesNotMatch(la.result.content[0].text, /beta#/);

  let status = node(['status'], sb.env).stdout;
  assert.match(status, /alpha#/);
  assert.match(status, /beta#/);

  // One agent leaving ends its session only.
  assert.equal(await a.close(), 0);
  await until(() => !/alpha#/.test(node(['status'], sb.env).stdout), 3000, 'alpha session ends');
  status = node(['status'], sb.env).stdout;
  assert.match(status, /beta#/);
  assert.equal((await b.call('log')).result.isError, undefined);

  // The agent closing stdin ends the pipe.
  assert.equal(await b.close(), 0);
});

/** The daemon's pid, as `sutradhar status` tells it (null when none runs). */
const daemonPid = (env) => +(node(['status'], env).stdout.match(/pid (\d+)/)?.[1] ?? 0) || null;

test('a daemon restart mid-session: the call in flight fails, the next one works, no new initialize', { skip, timeout: 30000 }, async (t) => {
  const sb = sandbox();
  const d = startDaemon(sb);
  await until(() => existsSync(join(sb.dir, 'mcp.sock')), 5000, 'mcp.sock');
  const c = mcp(PIPE, ['--name', 'keeper'], sb.env);
  let d2;
  t.after(() => { c.proc.kill(); d.proc.kill('SIGKILL'); d2?.kill(); const p = daemonPid(sb.env); if (p) process.kill(p); sb.cleanup(); });
  await c.init();
  assert.match((await c.call('log')).result.content[0].text, /"session":"keeper#\d+"/);

  // Frozen, the daemon has the call but never answers; then it dies.
  d.proc.kill('SIGSTOP');
  const inFlight = c.call('log');
  await new Promise((r) => setTimeout(r, 300));
  d.proc.kill('SIGKILL');
  const lost = await inFlight;
  assert.equal(lost.error.code, -32000);
  assert.match(lost.error.message, /sutradhar daemon restarted; try again/);

  // The service comes back (as systemd would restart it); the same client carries on.
  d2 = startDaemon(sb);
  const again = await c.call('log');
  assert.equal(again.result.isError, undefined);
  assert.match(again.result.content[0].text, /"session":"keeper#\d+"/);
  const tools = await c.rpc('tools/list', {});
  assert.ok(tools.result.tools.some((x) => x.name === 'navigate'));
  assert.match(node(['status'], sb.env).stdout, /keeper#/);
  assert.equal(c.proc.exitCode, null);
});

test('no daemon for a whole round: waiting calls fail, the next call tries again', { skip, timeout: 30000 }, async (t) => {
  const sb = sandbox();
  const d = startDaemon(sb);
  await until(() => existsSync(join(sb.dir, 'mcp.sock')), 5000, 'mcp.sock');
  const c = mcp(PIPE, ['--name', 'patient'], { ...sb.env, SUTRADHAR_MCP_RECONNECT_MS: '4000' });
  t.after(() => { chmodSync(sb.dir, 0o700); c.proc.kill(); d.kill(); const p = daemonPid(sb.env); if (p) process.kill(p); sb.cleanup(); });
  await c.init();
  // The daemon dies, and no new one can take its socket (the directory is read-only).
  const gone = new Promise((r) => d.proc.once('exit', r));
  d.proc.kill('SIGKILL');
  await gone;
  chmodSync(sb.dir, 0o500);
  const queued = await c.call('log');
  assert.match(queued.error.message, /sutradhar daemon restarted; try again/);
  assert.equal(c.proc.exitCode, null);
  // Fixed: the next call starts a daemon and gets through.
  chmodSync(sb.dir, 0o700);
  const next = await c.call('log');
  assert.match(next.result.content[0].text, /"session":"patient#\d+"/);
});

test('the pipe starts a daemon when none runs', { skip, timeout: 30000 }, async (t) => {
  const sb = sandbox();
  const c = mcp(PIPE, ['--name', 'starter'], sb.env);
  let pid;
  t.after(() => { c.proc.kill(); if (pid) process.kill(pid); sb.cleanup(); });
  const init = await c.init();
  assert.match(init.result.instructions, /untrusted/);
  const status = node(['status'], sb.env).stdout;
  pid = +status.match(/pid (\d+)/)[1];
  assert.match((await c.call('log')).result.content[0].text, /"session":"starter#\d+"/);
  assert.match(readFileSync(`/proc/${pid}/cmdline`, 'utf8'), /sutradhar\.mjs\0daemon/);
});

test('no mcp.sock (an older daemon): the pipe becomes the node server', { skip, timeout: 30000 }, async (t) => {
  const sb = sandbox();
  // This daemon listens elsewhere for MCP, so the pipe finds the agent socket but no mcp.sock.
  const d = startDaemon({ ...sb, env: { ...sb.env, SUTRADHAR_MCP_SOCKET: join(sb.dir, 'elsewhere.sock') } });
  await until(() => existsSync(join(sb.dir, 'elsewhere.sock')), 5000, 'daemon');
  const c = mcp(PIPE, ['--name', 'fallback'], sb.env);
  t.after(() => { c.proc.kill(); d.kill(); sb.cleanup(); });
  const init = await c.init();
  assert.match(init.result.instructions, /untrusted/);
  assert.match(readFileSync(`/proc/${c.proc.pid}/cmdline`, 'utf8'), /sutradhar\.mjs\0mcp\0--name\0fallback/);
  assert.ok((await c.rpc('tools/list', {})).result.tools.some((x) => x.name === 'navigate'));
  assert.match((await c.call('log')).result.content[0].text, /"session":"fallback#\d+"/);
});
