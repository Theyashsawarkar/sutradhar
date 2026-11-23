import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

beforeAll(() => { process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'sutradhar-cfg-')); });

describe('config and site rules', () => {
  it('defaults, saves and matches the longest host', async () => {
    const c = await import('../../packages/daemon/src/config.ts');
    const cfg = c.reloadConfig();
    expect(cfg.handoff.timeout_minutes).toBe(15);
    expect(c.siteRule('https://mail.example.com/x', 'approve', 'ask')).toBe('ask');
    cfg.sites['example.com'] = { approve: 'allow' };
    cfg.sites['mail.example.com'] = { approve: 'deny' };
    c.saveConfig(cfg);
    const again = c.reloadConfig();
    expect(again.sites['example.com'].approve).toBe('allow');
    expect(c.siteRule('https://www.example.com/', 'approve', 'ask')).toBe('allow');
    expect(c.siteRule('https://mail.example.com/', 'approve', 'ask')).toBe('deny');
    expect(c.siteRule('https://notexample.com/', 'approve', 'ask')).toBe('ask');
    expect(c.riskConfig().handoffHosts).toContain('razorpay.com');
  });
});
