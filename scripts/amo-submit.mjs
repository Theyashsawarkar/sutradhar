// Submits the current release to addons.mozilla.org (listed): the store
// build, the source archive and the listing in packaging/amo-metadata.json.
//
//   node scripts/amo-submit.mjs            (after `pnpm build` and tagging)
//
// The API key pair lives outside the repo, in ~/.config/sutradhar/amo.toml:
//   issuer = "user:12345:678"
//   secret = "…"
// Create it at https://addons.mozilla.org/developers/addon/api/key/ .
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfgPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'sutradhar', 'amo.toml');
if (!existsSync(cfgPath)) { console.error(`no ${cfgPath}: create the key pair at https://addons.mozilla.org/developers/addon/api/key/`); process.exit(1); }
const { issuer, secret } = parse(readFileSync(cfgPath, 'utf8'));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const source = join(root, 'dist', 'sutradhar-source.zip');
execFileSync('git', ['archive', '--format=zip', `--prefix=sutradhar-${version}/`, '-o', source, `v${version}`], { cwd: root, stdio: 'inherit' });
// The keys go through the environment, never the command line (other users can read argv).
execFileSync('npx', ['--yes', 'web-ext@8', 'sign', '--channel', 'listed',
  '--source-dir', join(root, 'dist', 'firefox-amo'), '--artifacts-dir', join(root, 'dist', 'amo'),
  '--upload-source-code', source, '--amo-metadata', join(root, 'packaging', 'amo-metadata.json'), '--approval-timeout', '0'],
  { cwd: root, stdio: 'inherit', env: { ...process.env, WEB_EXT_API_KEY: String(issuer), WEB_EXT_API_SECRET: String(secret) } });
