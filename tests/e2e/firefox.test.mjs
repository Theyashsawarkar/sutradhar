import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { launchFirefox } from './harness.mjs';
import { scenario } from './scenario.mjs';

let has = true;
try { execFileSync('sh', ['-c', 'command -v firefox'], { stdio: 'ignore' }); } catch { has = false; }
test('firefox end to end', { timeout: 300000, skip: !has && 'Firefox is not installed' }, (t) => scenario(t, { launch: (sb) => launchFirefox(sb), engine: 'gecko' }));
