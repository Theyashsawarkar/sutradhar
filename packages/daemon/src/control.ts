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
    if (s.recording) { clearInterval(s.recording.timer); }
  }
  settleAll('stopped');
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
