// Stop and resume: one Stop ends everything agents are doing, everywhere.

import { settleAll } from './gates.ts';
import { notify } from './notify.ts';
import { D, log } from './state.ts';

export async function stopAll(from: string) {
  let calls = 0;
  for (const s of D.sessions.values()) {
    s.stopped = true;
    for (const ac of s.calls) { ac.abort(); calls++; }
    s.calls.clear();
  }
  settleAll('stopped');
  if (takeover.paused) { takeover.paused = false; await Promise.all([...D.browsers.values()].map((b) => b.client.ui.paused.mutate({ paused: false }).catch(() => {}))); }
  await Promise.all([...D.browsers.values()].map((b) => b.client.ui.stop.mutate().catch(() => {})));
  log({ event: 'stop', from, calls });
  notify({ title: 'Sutradhar stopped', body: `Every agent was stopped (${from}). They'll ask before carrying on.`, urgency: 'normal' });
  return { stoppedSessions: D.sessions.size, cancelledCalls: calls };
}

export function resume() {
  for (const s of D.sessions.values()) s.stopped = false;
  log({ event: 'resume' });
  return true;
}

/** The user took over (Pause): agents' calls and steps wait until they hand back. */
export const takeover = { paused: false, since: 0 };

export async function pause(from: string) {
  if (takeover.paused) return true;
  takeover.paused = true; takeover.since = Date.now();
  await Promise.all([...D.browsers.values()].map((b) => b.client.ui.paused.mutate({ paused: true }).catch(() => {})));
  log({ event: 'pause', from });
  return true;
}

export async function handback(from: string) {
  if (!takeover.paused) return true;
  takeover.paused = false;
  await Promise.all([...D.browsers.values()].map((b) => b.client.ui.paused.mutate({ paused: false }).catch(() => {})));
  log({ event: 'handback', from, ms: Date.now() - takeover.since });
  return true;
}

/** Waits while the user has control (Stop still ends it). */
export async function whileUserHasControl(signal: AbortSignal) {
  while (takeover.paused && !signal.aborted) await new Promise((r) => setTimeout(r, 250));
}
