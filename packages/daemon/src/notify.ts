// Desktop notifications (akashvani, or any freedesktop server) through
// notify-send, with buttons. The user's click comes back as an action key.

import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { root } from './install.ts';

export interface Shown { close: () => void; id?: number }

const icon = () => {
  const p = join(root(), 'assets', 'logo.svg');
  return existsSync(p) ? p : 'dialog-information';
};

/**
 * Shows a notification. `onAction` gets the key of the button pressed
 * ("default" for a click on the body). Returns a handle to close it.
 */
export function notify(opts: { title: string; body: string; urgency?: 'low' | 'normal' | 'critical'; actions?: Record<string, string>; replaceId?: number; onAction?: (key: string) => void }): Shown {
  const shown: Shown = { close: () => {} };
  if (!loadConfig().notify.enabled) return shown;
  const cmd = process.env.SUTRADHAR_NOTIFY_CMD || 'notify-send';
  const args = ['-a', 'Sutradhar', '-u', opts.urgency ?? 'critical', '-i', icon(), '-p'];
  for (const [k, label] of Object.entries(opts.actions ?? {})) args.push('-A', `${k}=${label}`);
  if (opts.actions && Object.keys(opts.actions).length) args.push('--wait');
  if (opts.replaceId) args.push('-r', String(opts.replaceId));
  args.push(opts.title, opts.body);
  let child;
  try {
    child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return shown; }
  child.on('error', () => {});
  let out = '';
  child.stdout?.on('data', (d) => {
    out += d.toString();
    const lines = out.split('\n');
    if (shown.id === undefined && lines.length > 1 && /^\d+$/.test(lines[0])) shown.id = +lines[0];
  });
  child.on('close', () => {
    const lines = out.trim().split('\n').filter(Boolean);
    const action = lines.length > 1 ? lines[lines.length - 1] : undefined;
    if (action && opts.onAction) opts.onAction(action);
  });
  shown.close = () => {
    if (shown.id !== undefined && !process.env.SUTRADHAR_NOTIFY_CMD) {
      execFile('gdbus', ['call', '--session', '--dest', 'org.freedesktop.Notifications', '--object-path', '/org/freedesktop/Notifications',
        '--method', 'org.freedesktop.Notifications.CloseNotification', String(shown.id)], () => {});
    }
    opts.onAction = undefined;
    try { child.kill(); } catch { /* */ }
  };
  return shown;
}
