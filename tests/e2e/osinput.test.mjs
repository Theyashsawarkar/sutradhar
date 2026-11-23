// Real mouse and keyboard (sway seat cursor + wtype), in a private headless
// sway started by tests/e2e/nested-sway.sh. Never runs against the user's desktop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { agent, fixtures, launchGecko, sandbox, startDaemon, until } from './harness.mjs';

const nested = process.env.SUTRADHAR_NESTED_SWAYSOCK;
const zen = ['/opt/zen-browser-bin/zen-bin', '/usr/bin/zen-browser'].find(existsSync);

test('real mouse and keyboard in Zen', { timeout: 120000, skip: !nested ? 'run through tests/e2e/nested-sway.sh' : !zen && 'no Zen' }, async (t) => {
  const sb = sandbox();
  sb.env.SWAYSOCK = nested;
  delete sb.env.SUTRADHAR_NO_OS_INPUT;
  const site = await fixtures();
  const d = startDaemon(sb);
  await until(() => existsSync(sb.env.SUTRADHAR_SOCKET), 5000, 'daemon');
  const br = launchGecko(sb, zen, 'about:blank', false);
  let a;
  t.after(() => { a?.socket.destroy(); br.kill(); d.kill(); site.close(); sb.cleanup(); });
  a = await agent(sb, 'ostest');
  const c = a.client;
  await until(async () => (await c.browsers.mutate({})).includes('*'), 60000, 'zen');
  await c.navigate.mutate({ url: site.url + '/' });
  await new Promise((r) => setTimeout(r, 1500));

  // A synthetic click is seen as synthetic…
  let r = await c.act.mutate({ steps: [{ do: 'click', selector: '#trusted' }] });
  assert.match(await c.page_text.query({ all: true }), /synthetic/);
  // …and the real mouse as trusted.
  r = await c.act.mutate({ steps: [{ do: 'click', selector: '#trusted', trusted: true }] });
  assert.doesNotMatch(r, /FAILED/, r);
  await until(async () => /\btrusted\b/.test(await c.page_text.query({ all: true })), 5000, 'trusted click').catch((e) => { console.log(d.stderr()); throw e; });

  // Real typing.
  r = await c.act.mutate({ steps: [{ do: 'type', selector: '#name', value: 'Ravi', trusted: true }] });
  assert.doesNotMatch(r, /FAILED/, r);
  assert.match(await c.page_text.query({ all: true }), /state:Ravi/);

  // The browser's own address bar, which no extension can script (the user allows it).
  sb.setAnswer('approved');
  r = await c.os_input.mutate({ why: 'test', steps: [{ do: 'key', keys: 'Control+l' }, { do: 'type', text: site.url + '/page2.html' }, { do: 'key', keys: 'Return' }] });
  sb.setAnswer(null);
  await until(async () => /Second page/.test(await c.tabs.query({})), 10000, 'address bar navigation');
});
