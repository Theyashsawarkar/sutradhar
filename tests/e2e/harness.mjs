// End-to-end harness: a fixture web server, a test daemon on its own socket,
// and a throwaway browser profile with the built extension. Never touches
// the user's real browser, profile, daemon or desktop.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX = join(ROOT, 'tests', 'fixtures');
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.txt': 'text/plain' };

export async function fixtures() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const base = 41000 + Math.floor(Math.random() * 20000);
    const servers = [];
    try {
      for (const port of [base, base + 1]) {
        const s = createServer((req, res) => {
          const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
          const file = join(FIX, path === '/' ? 'index.html' : path.slice(1));
          if (!file.startsWith(FIX) || !existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
          res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
          res.end(readFileSync(file));
        });
        await new Promise((ok, fail) => { s.once('error', fail); s.listen(port, '127.0.0.1', ok); });
        servers.push(s);
      }
      return { url: `http://127.0.0.1:${base}`, close: () => servers.forEach((s) => s.close()) };
    } catch { servers.forEach((s) => s.close()); }
  }
  throw new Error('no free ports');
}

export function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'sutradhar-e2e-'));
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const notifyLog = join(dir, 'notify.log');
  const notify = join(dir, 'notify.sh');
  // A fake notify-send: logs the call, prints an id, and (if asked) answers with an action.
  writeFileSync(notify, `#!/bin/sh\necho "$@" >> "${notifyLog}"\necho 7\nif [ -f "${dir}/answer" ]; then sleep 0.3; cat "${dir}/answer"; fi\n`, { mode: 0o755 });
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local/state'),
    XDG_DATA_HOME: join(home, '.local/share'),
    SUTRADHAR_SOCKET: join(dir, 'sutradhar.sock'),
    SUTRADHAR_NOTIFY_CMD: notify,
    SUTRADHAR_NO_OS_INPUT: '1',
    SUTRADHAR_DEBUG: process.env.SUTRADHAR_DEBUG ?? '',
  };
  delete env.SWAYSOCK;
  return { dir, home, env, notifyLog, setAnswer: (a) => (a ? writeFileSync(join(dir, 'answer'), a + '\n') : rmSync(join(dir, 'answer'), { force: true })), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function startDaemon(sb) {
  const p = spawn(process.execPath, [join(ROOT, 'dist', 'sutradhar.mjs'), 'daemon'], { env: sb.env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  return { proc: p, stderr: () => err, kill: () => p.kill() };
}

function hostManifests(sb, kind) {
  const host = join(ROOT, 'bin', 'sutradhar-host');
  if (kind === 'chromium') {
    const id = readFileSync(join(ROOT, 'extension', 'chrome-id.txt'), 'utf8').trim();
    const m = { name: 'sutradhar', description: 'test', path: host, type: 'stdio', allowed_origins: [`chrome-extension://${id}/`] };
    for (const d of ['.config/chromium/NativeMessagingHosts', 'chrome-profile/NativeMessagingHosts']) {
      mkdirSync(join(sb.home, d), { recursive: true });
      writeFileSync(join(sb.home, d, 'sutradhar.json'), JSON.stringify(m));
    }
  } else {
    const m = { name: 'sutradhar', description: 'test', path: host, type: 'stdio', allowed_extensions: ['sutradhar@theyashsawarkar.github.io'] };
    for (const d of ['.mozilla/native-messaging-hosts', '.config/mozilla/native-messaging-hosts', '.zen/native-messaging-hosts', '.config/zen/native-messaging-hosts']) {
      mkdirSync(join(sb.home, d), { recursive: true });
      writeFileSync(join(sb.home, d, 'sutradhar.json'), JSON.stringify(m));
    }
  }
}

export function launchChromium(sb, startUrl = 'about:blank') {
  hostManifests(sb, 'chromium');
  const ext = join(ROOT, 'dist', 'chrome');
  const profile = join(sb.home, 'chrome-profile');
  const p = spawn('chromium', [
    '--headless=new', `--user-data-dir=${profile}`, `--load-extension=${ext}`, `--disable-extensions-except=${ext}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch', '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,900', '--disable-gpu', startUrl,
  ], { env: sb.env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  return { proc: p, stderr: () => err, kill: () => p.kill('SIGKILL') };
}

export function launchGecko(sb, binary, startUrl = 'about:blank', headless = true) {
  hostManifests(sb, 'gecko');
  const profile = join(sb.home, 'gecko-profile');
  mkdirSync(join(profile, 'extensions'), { recursive: true });
  copyFileSync(join(ROOT, 'dist', 'sutradhar-firefox.xpi'), join(profile, 'extensions', 'sutradhar@theyashsawarkar.github.io.xpi'));
  writeFileSync(join(profile, 'user.js'), [
    'user_pref("xpinstall.signatures.required", false);',
    'user_pref("extensions.autoDisableScopes", 0);',
    'user_pref("extensions.enabledScopes", 15);',
    'user_pref("extensions.startupScanScopes", 15);',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
    'user_pref("extensions.webextensions.restrictedDomains", "");',
    'user_pref("zen.welcome-screen.seen", true);',
    'user_pref("browser.tabs.warnOnClose", false);',
  ].join('\n'));
  const args = [...(headless ? ['--headless'] : []), '--no-remote', '--profile', profile, '--window-size', '1280,900', startUrl];
  const env = headless ? { ...sb.env, MOZ_HEADLESS: '1' } : { ...sb.env, MOZ_ENABLE_WAYLAND: '1' };
  const p = spawn(binary, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  return { proc: p, stderr: () => err, kill: () => p.kill('SIGKILL') };
}

/** Firefox release only takes signed add-ons, except temporary ones: install over WebDriver BiDi. */
export function launchFirefox(sb, binary = 'firefox') {
  hostManifests(sb, 'gecko');
  const profile = join(sb.home, 'firefox-profile');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'user.js'), [
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("browser.tabs.warnOnClose", false);',
    'user_pref("extensions.webextensions.restrictedDomains", "");',
  ].join('\n'));
  const port = 30000 + Math.floor(Math.random() * 10000);
  const p = spawn(binary, ['--headless', '--no-remote', '--profile', profile, `--remote-debugging-port=${port}`, 'about:blank'], { env: { ...sb.env, MOZ_HEADLESS: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  const installed = (async () => {
    await until(() => /WebDriver BiDi listening/.test(err), 30000, 'Firefox BiDi');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
    await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
    let id = 0;
    const call = (method, params) => new Promise((ok, fail) => {
      const my = ++id;
      const onMsg = (ev) => { const m = JSON.parse(ev.data); if (m.id !== my) return; ws.removeEventListener('message', onMsg); m.type === 'error' ? fail(new Error(m.message || m.error)) : ok(m.result); };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id: my, method, params }));
    });
    await call('session.new', { capabilities: {} });
    await call('webExtension.install', { extensionData: { type: 'archivePath', path: join(ROOT, 'dist', 'sutradhar-firefox.xpi') } });
    return ws;
  })();
  installed.catch(() => {});
  return { proc: p, stderr: () => err, kill: () => { installed.then((ws) => ws.close()).catch(() => {}); p.kill('SIGKILL'); } };
}

/** An agent connected to the test daemon (the same client `sutradhar mcp` uses). */
export async function agent(sb, name = 'tester') {
  process.env.SUTRADHAR_SOCKET = sb.env.SUTRADHAR_SOCKET;
  const { agentClient } = await import('../../packages/daemon/src/client.ts');
  return agentClient(name);
}

export async function until(fn, timeout = 20000, what = 'condition') {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}${last ? ': ' + last.message : ''}`);
}
