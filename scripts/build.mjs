// Builds everything into dist/:
//   dist/sutradhar.mjs            the daemon/host/MCP/CLI (one file, Node 22+)
//   dist/chrome/                  the extension for Chrome, Chromium, Brave (MV3)
//   dist/firefox/                 the extension for Firefox and Zen (MV2, persistent background)
//   dist/sutradhar-firefox.xpi    the same, zipped for "Install Add-on From File"
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// ---------------------------------------------------------------- daemon
await build({
  entryPoints: [join(root, 'packages/daemon/src/main.ts')],
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  outfile: join(dist, 'sutradhar.mjs'),
  define: { 'process.env.SUTRADHAR_VERSION': JSON.stringify(version) },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});

// ---------------------------------------------------------------- extension
const ext = join(root, 'extension');
const entries = {
  background: join(ext, 'src/background/background.ts'),
  content: join(ext, 'src/content/content.ts'),
  'main-world': join(ext, 'src/main-world.ts'),
  panel: join(ext, 'src/panel/panel.ts'),
};
const common = {
  name: 'Sutradhar',
  description: 'Lets AI agents use this browser like you do; payments, passwords and other risky steps stay yours.',
  version,
  icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
  // No default key: the global one is Super+Shift+Delete in sway (sutradhar stop); users may set one in the browser.
  commands: { 'stop-agents': { description: 'Stop every agent' } },
};
const perms = ['tabs', 'scripting', 'webNavigation', 'webRequest', 'downloads', 'bookmarks', 'history', 'cookies', 'storage', 'nativeMessaging', 'alarms'];
const contentScripts = (withMain) => [
  ...(withMain ? [{ matches: ['<all_urls>'], js: ['main-world.js'], run_at: 'document_start', all_frames: true, match_about_blank: true, world: 'MAIN' }] : []),
  { matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_start', all_frames: true, match_about_blank: true },
];

const manifests = {
  chrome: {
    manifest_version: 3, ...common,
    key: readFileSync(join(ext, 'key.pub.b64'), 'utf8').trim(),
    minimum_chrome_version: '116',
    action: { default_popup: 'panel.html', default_title: 'Sutradhar', default_icon: common.icons },
    background: { service_worker: 'background.js' },
    permissions: [...perms, 'tabGroups', 'debugger'],
    host_permissions: ['<all_urls>'],
    content_scripts: contentScripts(true),
  },
  firefox: {
    manifest_version: 2, ...common,
    browser_specific_settings: { gecko: { id: 'sutradhar@theyashsawarkar.github.io', strict_min_version: '128.0',
      // Self-distributed updates: Firefox/Zen check this file and install newer releases.
      update_url: 'https://raw.githubusercontent.com/Theyashsawarkar/sutradhar/main/updates.json' } },
    browser_action: { default_popup: 'panel.html', default_title: 'Sutradhar', default_icon: common.icons },
    background: { scripts: ['background.js'], persistent: true },
    permissions: [...perms, 'tabGroups', '<all_urls>'],
    content_scripts: contentScripts(false),
  },
};

for (const [target, manifest] of Object.entries(manifests)) {
  const out = join(dist, target);
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: entries, bundle: true, format: 'iife', target: target === 'chrome' ? 'chrome116' : 'firefox128',
    outdir: out, logLevel: 'warning', define: { 'process.env.NODE_ENV': '"production"' },
  });
  cpSync(join(ext, 'src/panel/panel.html'), join(out, 'panel.html'));
  cpSync(join(ext, 'src/panel/panel.css'), join(out, 'panel.css'));
  cpSync(join(ext, 'src/panel/idle.html'), join(out, 'idle.html'));
  cpSync(join(ext, 'icons'), join(out, 'icons'), { recursive: true });
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

// Zip for Firefox/Zen (python's zipfile: no zip binary needed).
execFileSync('python3', ['-I', '-c', `
import os, sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as z:
    for base, _, files in os.walk(src):
        for f in sorted(files):
            p = os.path.join(base, f)
            z.write(p, os.path.relpath(p, src))
`, join(dist, 'firefox'), join(dist, 'sutradhar-firefox.xpi')]);

// The update manifest Firefox/Zen read (committed at the repo root; points at the release's .xpi).
// Only for a release (`pnpm release-manifest`): an ordinary build, like kosha's, leaves the checkout clean.
if (process.argv.includes('--release')) writeFileSync(join(root, 'updates.json'), JSON.stringify({ addons: { 'sutradhar@theyashsawarkar.github.io': { updates: [
  { version, update_link: `https://github.com/Theyashsawarkar/sutradhar/releases/download/v${version}/sutradhar-firefox.xpi` },
] } } }, null, 2) + '\n');

console.log(`built sutradhar ${version} → dist/`);
