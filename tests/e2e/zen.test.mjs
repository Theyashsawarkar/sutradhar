import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { launchGecko } from './harness.mjs';
import { scenario } from './scenario.mjs';

const zen = ['/opt/zen-browser-bin/zen-bin', '/usr/bin/zen-browser'].find(existsSync);
test('zen end to end', { timeout: 300000, skip: !zen && 'Zen is not installed' }, (t) => scenario(t, { launch: (sb) => launchGecko(sb, zen), engine: 'gecko' }));
