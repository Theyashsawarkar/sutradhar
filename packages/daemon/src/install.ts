// `sutradhar install`: native-messaging manifests for every browser, the
// systemd user service, the logo for notifications. `doctor` checks them.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from './paths.ts';

export const HOST_NAME = 'sutradhar';
export const GECKO_ID = 'sutradhar@theyashsawarkar.github.io';

/** The repo (or installed tree) this binary runs from: dist/ is beside bin/. */
export function root() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const up of ['..', '../..', '../../..']) {
    const r = resolve(here, up);
    if (existsSync(join(r, 'bin', 'sutradhar-host'))) return r;
  }
  return resolve(here, '..');
}

export function chromeId() {
  try { return readFileSync(join(root(), 'extension', 'chrome-id.txt'), 'utf8').trim(); } catch { return ''; }
}

const H = paths.home;
export const CHROMIUM_DIRS: Record<string, string> = {
  chrome: join(H, '.config/google-chrome/NativeMessagingHosts'),
  'chrome-beta': join(H, '.config/google-chrome-beta/NativeMessagingHosts'),
  chromium: join(H, '.config/chromium/NativeMessagingHosts'),
  brave: join(H, '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts'),
  edge: join(H, '.config/microsoft-edge/NativeMessagingHosts'),
  vivaldi: join(H, '.config/vivaldi/NativeMessagingHosts'),
};
// Firefox reads ~/.mozilla; newer XDG builds and Zen look in their own config dirs too.
export const GECKO_DIRS: Record<string, string> = {
  firefox: join(H, '.mozilla/native-messaging-hosts'),
  'firefox-xdg': join(H, '.config/mozilla/native-messaging-hosts'),
  zen: join(H, '.zen/native-messaging-hosts'),
  'zen-xdg': join(H, '.config/zen/native-messaging-hosts'),
};

export function install(opts: { service?: boolean } = {}) {
  const r = root();
  const hostPath = join(r, 'bin', 'sutradhar-host');
  const id = chromeId();
  const out: string[] = [];
  const chromium = { name: HOST_NAME, description: 'sutradhar: lets AI agents use this browser', path: hostPath, type: 'stdio', allowed_origins: [`chrome-extension://${id}/`] };
  const gecko = { name: HOST_NAME, description: 'sutradhar: lets AI agents use this browser', path: hostPath, type: 'stdio', allowed_extensions: [GECKO_ID] };
  for (const [name, dir] of Object.entries(CHROMIUM_DIRS)) {
    // Only for browsers that exist (their config dir is there).
    if (!existsSync(dirname(dir)) && name !== 'chrome') continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${HOST_NAME}.json`), JSON.stringify(chromium, null, 2));
    out.push(`${name}: ${join(dir, HOST_NAME + '.json')}`);
  }
  for (const [name, dir] of Object.entries(GECKO_DIRS)) {
    if ((name.startsWith('zen') && !existsSync(dirname(dir))) || (name === 'firefox-xdg' && !existsSync(dirname(dir)))) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${HOST_NAME}.json`), JSON.stringify(gecko, null, 2));
    out.push(`${name}: ${join(dir, HOST_NAME + '.json')}`);
  }
  mkdirSync(paths.data, { recursive: true });
  const logo = join(r, 'assets', 'logo.svg');
  if (existsSync(logo)) copyFileSync(logo, join(paths.data, 'logo.svg'));
  if (opts.service !== false) {
    const unitDir = join(H, '.config/systemd/user');
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, 'sutradhar.service'), `[Unit]
Description=sutradhar: browser hands for AI agents
After=graphical-session.target
PartOf=graphical-session.target

[Service]
ExecStart=${join(r, 'bin', 'sutradhar')} daemon
Restart=on-failure
RestartSec=2

[Install]
WantedBy=graphical-session.target
`);
    try {
      execFileSync('systemctl', ['--user', 'daemon-reload']);
      execFileSync('systemctl', ['--user', 'enable', '--now', 'sutradhar.service']);
      out.push('service: sutradhar.service enabled');
    } catch (e) { out.push(`service: could not enable (${(e as Error).message.split('\n')[0]})`); }
  }
  return out;
}

export function uninstall() {
  for (const dir of [...Object.values(CHROMIUM_DIRS), ...Object.values(GECKO_DIRS)]) rmSync(join(dir, `${HOST_NAME}.json`), { force: true });
  try { execFileSync('systemctl', ['--user', 'disable', '--now', 'sutradhar.service'], { stdio: 'ignore' }); } catch { /* */ }
  rmSync(join(H, '.config/systemd/user/sutradhar.service'), { force: true });
}

export function extensionHelp() {
  const r = root();
  return `Add the extension to each browser:
  Chrome, Chromium, Brave: open chrome://extensions, turn on Developer mode, "Load unpacked" → ${join(r, 'dist', 'chrome')}
  Zen: open about:addons → gear → "Install Add-on From File…" → ${join(r, 'dist', 'sutradhar-firefox.xpi')}
       (Zen accepts unsigned add-ons; xpinstall.signatures.required is false there)
  Firefox: needs the signed .xpi from a release (Mozilla signs it); for development, about:debugging → "Load Temporary Add-on" → ${join(r, 'dist', 'firefox', 'manifest.json')}`;
}
