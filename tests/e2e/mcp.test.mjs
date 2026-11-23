// The MCP server speaks MCP on stdio and lists the agent tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, sandbox, startDaemon, until } from './harness.mjs';

test('mcp server lists tools and answers calls', { timeout: 30000 }, async (t) => {
  const sb = sandbox();
  const d = startDaemon(sb);
  await until(() => existsSync(sb.env.SUTRADHAR_SOCKET), 5000, 'daemon');
  const p = spawn(process.execPath, [join(ROOT, 'dist', 'sutradhar.mjs'), 'mcp', '--name', 'mcptest'], { env: sb.env, stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => { p.kill(); d.kill(); sb.cleanup(); });
  let buf = '';
  const waiting = new Map();
  p.stdout.on('data', (x) => {
    buf += x;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((ok) => { const my = ++id; waiting.set(my, ok); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n'); });
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.match(init.result.instructions, /untrusted/);
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = await rpc('tools/list', {});
  const names = tools.result.tools.map((x) => x.name);
  for (const n of ['navigate', 'snapshot', 'act', 'screenshot', 'handoff', 'os_input', 'downloads', 'record']) assert.ok(names.includes(n), n);
  const act = tools.result.tools.find((x) => x.name === 'act');
  assert.equal(act.inputSchema.type, 'object');
  assert.ok(act.inputSchema.properties.steps);
  const r = await rpc('tools/call', { name: 'tabs', arguments: {} });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /No browser is connected/);
});
