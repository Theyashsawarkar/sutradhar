// ~/.config/sutradhar/config.toml: hand-off timing, OS input, per-site rules.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { DEFAULT_RISK, type RiskConfig } from '../../../extension/src/content/risk.ts';
import { configFile } from './paths.ts';

export type Rule = 'allow' | 'ask' | 'deny';

export interface SiteRule { approve?: Rule; eval?: Rule; cookies?: Rule; act?: Rule }

export interface Config {
  handoff: { timeout_minutes: number; reminder_minutes: number; extra_hosts: string[] };
  /** enabled: also ask before send/publish/delete, eval_js, cookies, clipboard reads, tab_attach, os_input. */
  approve: { enabled: boolean; timeout_minutes: number };
  os_input: { enabled: boolean; auto_retry: boolean };
  notify: { enabled: boolean };
  sites: Record<string, SiteRule>;
}

const DEFAULTS: Config = {
  handoff: { timeout_minutes: 15, reminder_minutes: 5, extra_hosts: [] },
  approve: { enabled: false, timeout_minutes: 5 },
  os_input: { enabled: true, auto_retry: true },
  notify: { enabled: true },
  sites: {},
};

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  let raw: any = {};
  try { raw = parse(readFileSync(configFile(), 'utf8')); } catch { /* no file: defaults */ }
  cached = {
    handoff: { ...DEFAULTS.handoff, ...(raw.handoff ?? {}) },
    approve: { ...DEFAULTS.approve, ...(raw.approve ?? {}) },
    os_input: { ...DEFAULTS.os_input, ...(raw.os_input ?? {}) },
    notify: { ...DEFAULTS.notify, ...(raw.notify ?? {}) },
    sites: raw.sites ?? {},
  };
  if (process.env.SUTRADHAR_NO_OS_INPUT) cached.os_input.enabled = false;
  return cached;
}

export function saveConfig(c: Config) {
  mkdirSync(dirname(configFile()), { recursive: true });
  writeFileSync(configFile(), '# sutradhar settings (see the README)\n' + stringify(c as never) + '\n');
  cached = c;
}

export function reloadConfig() { cached = null; return loadConfig(); }

export function riskConfig(): RiskConfig {
  const c = loadConfig();
  return { ...DEFAULT_RISK, handoffHosts: [...DEFAULT_RISK.handoffHosts, ...c.handoff.extra_hosts] };
}

/** Whether a non-risky step (send, eval_js…) on this site needs the user's Allow. */
export function needsApproval(url: string, what: keyof SiteRule): Rule {
  return siteRule(url, what, loadConfig().approve.enabled ? 'ask' : 'allow');
}

/** The rule for `what` on the site of `url` (longest matching host wins). */
export function siteRule(url: string, what: keyof SiteRule, fallback: Rule): Rule {
  let host = '';
  try { host = new URL(url).hostname; } catch { return fallback; }
  const sites = loadConfig().sites;
  let best: { len: number; rule?: Rule } = { len: -1 };
  for (const [pattern, rule] of Object.entries(sites)) {
    if ((host === pattern || host.endsWith('.' + pattern)) && pattern.length > best.len && rule[what]) best = { len: pattern.length, rule: rule[what] };
  }
  return best.rule ?? fallback;
}
