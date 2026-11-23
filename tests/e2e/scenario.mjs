// The same end-to-end checks for every browser engine.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { agent, fixtures, ROOT, sandbox, startDaemon, until } from './harness.mjs';
import { readFileSync, existsSync } from 'node:fs';

const ONLY = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY, 'i') : null;
const only = (t, name, fn) => t.test(name, { skip: !!(ONLY && !ONLY.test(name) && name !== 'connects and navigates') }, fn);

export async function scenario(t, { launch, engine }) {
  const sb = sandbox();
  const site = await fixtures();
  const daemon = startDaemon(sb);
  await until(() => existsSync(sb.env.SUTRADHAR_SOCKET), 5000, 'daemon socket');
  const browser = launch(sb);
  let a;
  t.after(() => { try { a?.socket.destroy(); } catch {} browser.kill(); daemon.kill(); site.close(); sb.cleanup(); });

  a = await agent(sb);
  const c = a.client;
  const listed = await until(async () => { const r = await c.browsers.mutate({}); return r.includes('*') ? r : null; }, 40000, `browser to connect\n${browser.stderr().slice(-2000)}\n${daemon.stderr()}`);
  const snap = async (o = {}) => c.snapshot.query(o);
  const act = async (steps, o = {}) => c.act.mutate({ steps, ...o });
  const text = async (sel) => (await c.find.query({ query: sel, limit: 1 }));
  const page = async () => c.page_text.query({ all: true });

  await only(t, 'connects and navigates', async () => {
    assert.match(listed, engine === 'gecko' ? /(zen|firefox)/ : /(chromium|chrome|brave)/);
    const r = await c.navigate.mutate({ url: site.url + '/' });
    assert.match(r, /loaded: Fixture home/);
    const tabs = await c.tabs.query({});
    assert.match(tabs, /\[yours · sutra\] Fixture home/, 'its tabs live in the sutra group');
    // Side by side: sutradhar's tab opened in the background, the user's tab stays in front.
    assert.doesNotMatch(tabs, /^\d+\*\s+\[yours/m, tabs);
  });

  await only(t, 'snapshot shows roles, refs, frames and shadow DOM', async () => {
    await until(async () => (await snap()).includes('frame clicked') || (await snap()).includes('Frame button'), 10000, 'iframe content');
    const s = await snap();
    assert.match(s, /heading "Fixture home"/);
    assert.match(s, /button "Add one" \[ref=e\d+\]/);
    assert.match(s, /textbox "Full name" \[ref=e\d+\]/);
    assert.match(s, /combobox "Country"/);
    assert.match(s, /button "Open shadow button"/);
    assert.match(s, /button "Closed shadow button"/);
    assert.match(s, /button "Frame button" \[ref=f\d+:e\d+\]/);
    assert.match(s, /clickable "Fancy div button"|button "Fancy div button"/);
  });

  await only(t, 'click, type into a controlled input, select, check, fill, submit', async () => {
    const r = await act([
      { do: 'click', text: 'Add one' }, { do: 'click', text: 'Add one' },
      { do: 'type', selector: '#name', value: 'Asha Rao' },
      { do: 'fill', fields: [{ selector: '#email', value: 'asha@example.com' }, { selector: '#country', value: 'Nepal' }, { selector: '#agree', value: true }, { selector: '#hidden-check', value: true }] },
      { do: 'type', selector: '#bio', value: 'line one' },
      { do: 'type', selector: '#editor', value: 'rich text' },
      { do: 'click', text: 'Save profile' },
    ]);
    assert.doesNotMatch(r, /FAILED/, r);
    const p = await page();
    assert.match(p, /\b2\b/);
    assert.match(p, /state:Asha Rao/);
    assert.match(p, /saved Asha Rao asha@example.com np true true line one rich text/);
  });

  await only(t, 'rich editors keep every line (ProseMirror-like model)', async () => {
    const r = await act([{ do: 'type', selector: '#model-editor', value: 'first line\nsecond line\nthird' }]);
    assert.doesNotMatch(r, /FAILED/, r);
    await until(async () => /model:first line\|second line\|third/.test(await page()), 5000, 'all three lines in the model');
  });

  await only(t, 'div buttons, shadow DOM and cross-origin frame clicks', async () => {
    let r = await act([{ do: 'click', text: 'Fancy div button' }, { do: 'click', text: 'Closed shadow button' }]);
    assert.doesNotMatch(r, /FAILED/, r);
    assert.match(await page(), /closed clicked/);
    const s = await snap();
    const ref = /button "Frame button" \[ref=(f\d+:e\d+)\]/.exec(s)[1];
    r = await act([{ do: 'click', ref }]);
    assert.doesNotMatch(r, /FAILED/, r);
    const after = await snap();
    assert.match(after, /frame clicked/);
  });

  await only(t, 'dialogs never block, and can be accepted', async () => {
    let r = await act([{ do: 'click', text: 'Show alert' }]);
    assert.match(r, /dialog: alert "Hello"/);
    r = await act([{ do: 'click', text: 'Ask yes or no' }]);
    assert.match(await page(), /confirm:false/);
    await c.dialog.mutate({ accept: true });
    await act([{ do: 'click', text: 'Ask yes or no' }]);
    assert.match(await page(), /confirm:true/);
    await c.dialog.mutate({ accept: true, text: 'Meera' });
    await act([{ do: 'click', text: 'Ask prompt' }]);
    assert.match(await page(), /prompt:Meera/);
  });

  await only(t, 'covered elements are reported, not clicked blindly', async () => {
    const r = await act([{ do: 'click', selector: '#covered' }]);
    assert.match(r, /covered by/);
  });

  await only(t, 'hover, scroll to the bottom, keys', async () => {
    let r = await act([{ do: 'hover', selector: '#hoverme' }]);
    assert.doesNotMatch(r, /FAILED/, r);
    assert.match(await page(), /hovered/);
    r = await act([{ do: 'scroll', direction: 'down', amount: 'end' }, { do: 'click', text: 'At the bottom' }]);
    assert.doesNotMatch(r, /FAILED/, r);
    assert.match(await page(), /bottom clicked/);
    r = await act([{ do: 'press', selector: '#name', keys: 'Control+a' }, { do: 'press', keys: 'Backspace' }]);
    assert.doesNotMatch(r, /FAILED/, r);
  });

  await only(t, 'upload a file and drag and drop', async () => {
    let r = await act([{ do: 'upload', selector: '#file', paths: [join(ROOT, 'tests/fixtures/upload.txt')] }]);
    assert.doesNotMatch(r, /FAILED/, r);
    await until(async () => /upload\.txt 13 hello upload/.test(await page()), 5000, 'file result');
    r = await act([{ do: 'upload', text: 'Attach photo', paths: [join(ROOT, 'tests/fixtures/upload.txt')] }]);
    assert.match(r, /no file picker opened/, r);
    await until(async () => /photo upload\.txt/.test(await page()), 5000, 'picker interception');
    r = await act([{ do: 'drag', from: { selector: '#dragme' }, to: { selector: '#dropzone' } }]);
    assert.doesNotMatch(r, /FAILED/, r);
    assert.match(await page(), /dropped payload/);
  });

  await only(t, 'console and network', async () => {
    const con = await c.console_read.query({});
    assert.match(con, /fixture loaded/);
    assert.match(con, /\[error\] fixture error line/);
    const net = await c.network_read.query({ pattern: 'data.json' });
    assert.match(net, /GET 200 .*data\.json/);
  });

  await only(t, 'network rules: block, mock, clear (testing tools)', async () => {
    await c.navigate.mutate({ url: site.url + '/' });
    await c.network_rules.mutate({ action: 'add', rule: { match: '/data.json', type: 'block' } });
    await act([{ do: 'click', text: 'Load data' }]);
    await until(async () => /load failed/.test(await page()), 5000, 'blocked request');
    await c.network_rules.mutate({ action: 'clear' });
    await c.network_rules.mutate({ action: 'add', rule: { match: '/data.json', type: 'mock', body: '{"items":[7,8,9]}' } });
    await act([{ do: 'click', text: 'Load data' }]);
    await until(async () => /items 7,8,9/.test(await page()), 5000, 'mocked response');
    assert.match(await c.network_rules.mutate({ action: 'list' }), /mock \/data\.json .*1 hit/);
    await c.network_rules.mutate({ action: 'clear' });
    await act([{ do: 'click', text: 'Load data' }]);
    await until(async () => /items 1,2,3/.test(await page()), 5000, 'real response again');
  });

  await only(t, 'site notes travel with the site', async () => {
    assert.match(await c.site_notes.mutate({ site: '127.0.0.1', add: 'Fixture: "Load data" fetches /data.json' }), /Load data/);
    const r = await c.navigate.mutate({ url: site.url + '/page2.html' });
    assert.match(r, /Notes for 127\.0\.0\.1/);
    await c.navigate.mutate({ action: 'back' });
  });

  await only(t, 'pause: steps wait while the user has control', async () => {
    const { connectRaw } = await import('../../packages/daemon/src/client.ts');
    const { createPeer } = await import('../../packages/protocol/src/rpc.ts');
    const sock = await connectRaw();
    const admin = createPeer({ send: (f) => sock.write(JSON.stringify(f) + '\n'), pathPrefix: 'admin.' });
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { admin.handle(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    await admin.client.pause.mutate();
    let done = false;
    const p = c.act.mutate({ steps: [{ do: 'click', text: 'Add one' }] }).then((r) => { done = true; return r; });
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(done, false, 'the step waited while paused');
    await admin.client.handback.mutate();
    const r = await p;
    assert.doesNotMatch(r, /FAILED/, r);
    sock.destroy();
  });

  await only(t, 'screenshots', async () => {
    const shot = await c.screenshot.query({});
    assert.ok(shot.image.data.length > 1000);
    const full = await c.screenshot.query({ full: true, format: 'png' });
    assert.equal(full.image.mime, 'image/png');
  });

  await only(t, 'payment fields and pay buttons are handed to the user', async () => {
    await c.navigate.mutate({ url: site.url + '/pay.html' });
    // The user "does it" and presses Done in the notification.
    sb.setAnswer('done');
    const r = await act([{ do: 'type', selector: '#cc', value: '4111111111111111' }], { why: 'buy the test item' });
    assert.match(r, /handoff-done/);
    const notes = readFileSync(sb.notifyLog, 'utf8');
    assert.match(notes, /sutradhar needs you/);
    assert.doesNotMatch(notes, /tester/, 'the agent is never named to the user');
    const s = await snap();
    assert.doesNotMatch(s, /4111/, 'the agent never typed the card number');
    sb.setAnswer('declined');
    const r2 = await act([{ do: 'click', text: 'Pay now' }]);
    assert.match(r2, /handoff-declined/);
    assert.match(await page(), /not paid/);
    // An ordinary field on the same page is fine.
    sb.setAnswer(null);
    const r3 = await act([{ do: 'type', selector: '#coupon', value: 'SAVE10' }]);
    assert.doesNotMatch(r3, /FAILED|handoff/, r3);
  });

  await only(t, 'send goes ahead without asking (only risky steps wait)', async () => {
    await c.navigate.mutate({ url: site.url + '/send.html' });
    const before = existsSync(sb.notifyLog) ? readFileSync(sb.notifyLog, 'utf8') : '';
    const r = await act([{ do: 'click', text: 'Send' }]);
    assert.doesNotMatch(r, /FAILED|denied|approved/, r);
    assert.match(await page(), /\bsent\b/);
    assert.equal(existsSync(sb.notifyLog) ? readFileSync(sb.notifyLog, 'utf8') : '', before, 'no notification for an ordinary step');
  });

  await only(t, 'tabs opened from an agent tab belong to it; others are off limits', async () => {
    await c.navigate.mutate({ url: site.url + '/' });
    const before = await c.tabs.query({});
    await act([{ do: 'click', text: 'New tab' }]);
    const after = await until(async () => { const x = await c.tabs.query({}); return /\[yours[^\]]*\] Opened tab/.test(x) ? x : null; }, 10000, 'popup tab');
    assert.ok(after.split('\n').length > before.split('\n').length);
    const foreign = /^(\d+)\*?\s+(?![\s[])/m.exec(after);
    if (foreign) await assert.rejects(c.snapshot.query({ tab: +foreign[1] }), /user's, not yours/);
  });

  await only(t, 'second page: markdown, waits, back', async () => {
    await c.navigate.mutate({ url: site.url + '/page2.html' });
    const md = await page();
    assert.match(md, /# Second page/);
    assert.match(md, /\| Asha \| 9 \|/);
    assert.match(await c.wait_for.query({ text: 'You made it' }), /there/);
    const back = await c.navigate.mutate({ action: 'back' });
    assert.match(back, /Fixture home|Opened tab|Compose/);
  });

  await only(t, 'the user sees a pointer and sutradhar, never the agent', async () => {
    await c.navigate.mutate({ url: site.url + '/' });
    // The pointer shows in a tab you can see (a hidden tab works without it).
    const cur = /current tab: (\d+)/.exec(await c.tabs.query({}))[1];
    await c.tab_focus.mutate({ tab: +cur });
    await act([{ do: 'click', text: 'Add one' }]);
    let r = await c.eval_js.mutate({ code: '!!document.querySelector("sutradhar-pointer")', why: 'test' });
    assert.match(r, /true/);
    // Over a modal dialog (the browser's top layer) the pointer must still be on top.
    await act([{ do: 'click', text: 'Open modal' }, { do: 'click', text: 'Inside modal' }]);
    assert.match(await page(), /modal clicked/);
    r = await c.eval_js.mutate({ code: 'document.querySelector("sutradhar-pointer").matches(":popover-open")', why: 'test' });
    assert.match(r, /true/);
  });

  await only(t, 'eval_js runs', async () => {
    const r = await c.eval_js.mutate({ code: 'document.title', why: 'test' });
    assert.match(r, /Fixture home|Second page|Compose/);
  });

  await only(t, 'downloads, PDF, recording, bookmarks, history, windows', async () => {
    await c.navigate.mutate({ url: site.url + '/page2.html' });
    await c.record.mutate({ action: 'start', format: 'gif' });
    await act([{ do: 'click', text: 'Download data' }]);
    const dl = await c.wait_for.query({ download: true, timeout: 20000 });
    assert.match(dl, /complete/);
    const read = await c.downloads.mutate({ action: 'read' });
    assert.match(read, /"items":\[1,2,3\]/);
    await new Promise((r) => setTimeout(r, 1600));
    const rec = await c.record.mutate({ action: 'stop', path: join(sb.dir, 'rec.gif') });
    assert.match(rec, /saved .*rec\.gif/);
    assert.ok(existsSync(join(sb.dir, 'rec.gif')));
    if (engine === 'chromium') {
      const pdf = await c.page_pdf.mutate({ path: join(sb.dir, 'page.pdf') });
      assert.match(pdf, /saved/);
      assert.equal(readFileSync(join(sb.dir, 'page.pdf')).subarray(0, 4).toString(), '%PDF');
    }
    await c.bookmarks.mutate({ add: { title: 'Sutradhar test mark', url: site.url + '/page2.html' } });
    assert.match(await c.bookmarks.mutate({ query: 'Sutradhar test' }), /Sutradhar test mark/);
    assert.match(await c.history.query({ query: 'Second' }), /Second page/);
    assert.match(await c.window.mutate({ action: 'list' }), /\d+x\d+/);
  });

  await only(t, 'handoff tool waits for the user', async () => {
    sb.setAnswer('done');
    const r = await c.handoff.mutate({ task: 'Log in to the test site', why: 'testing' });
    assert.match(r, /^done/);
    sb.setAnswer(null);
    assert.match(readFileSync(sb.notifyLog, 'utf8'), /Log in to the test site/);
  });

  await only(t, 'the last sutra tab is parked, not closed, and reused', async () => {
    const cur = +/current tab: (\d+)/.exec(await c.tabs.query({}))[1];
    for (const line of (await c.tabs.query({})).split('\n')) {
      const m = /^(\d+)\*?\s+\[yours/.exec(line);
      if (m && +m[1] !== cur) await c.tab_close.mutate({ tab: +m[1] });
    }
    assert.match(await c.tab_close.mutate({ tab: cur }), /parked/);
    await until(async () => /sutradhar · idle/.test(await c.tabs.query({})), 5000, 'idle page');
    await c.tab_open.mutate({ url: site.url + '/page2.html' });
    const tabs = await c.tabs.query({});
    assert.match(tabs, /\[yours · sutra\] Second page/);
    assert.doesNotMatch(tabs, /sutradhar · idle/, 'the parked tab was reused');
  });

  await only(t, 'stop ends everything until resumed', async () => {
    const { connectRaw } = await import('../../packages/daemon/src/client.ts');
    const { createPeer } = await import('../../packages/protocol/src/rpc.ts');
    const sock = await connectRaw();
    const peer = createPeer({ send: (f) => sock.write(JSON.stringify(f) + '\n'), pathPrefix: 'admin.' });
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { peer.handle(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    await peer.client.stop.mutate();
    await assert.rejects(c.tabs.query({}), /pressed Stop/);
    await peer.client.resume.mutate();
    assert.match(await c.tabs.query({}), /yours/);
    sock.destroy();
  });
}
