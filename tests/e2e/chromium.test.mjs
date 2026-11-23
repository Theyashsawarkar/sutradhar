import { test } from 'node:test';
import { launchChromium } from './harness.mjs';
import { scenario } from './scenario.mjs';

test('chromium end to end', { timeout: 300000 }, (t) => scenario(t, { launch: (sb) => launchChromium(sb), engine: 'chromium' }));
