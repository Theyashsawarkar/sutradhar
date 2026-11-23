// Waiting on the user. A hand-off is a step only the user may do (pay, type a
// password, solve a CAPTCHA); an approval is a step the agent may do once the
// user says yes. Either way the notification goes out first, the tab comes
// forward with a yellow "Your turn" card, and the agent's call waits.

import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.ts';
import { notify, type Shown } from './notify.ts';
import { focusWindow } from './osinput.ts';
import { D, log, type Gate, type Outcome } from './state.ts';

const label = (session: string) => session.replace(/#\d+$/, '');

function host(url: string) { try { return new URL(url).hostname; } catch { return url; } }

export async function openGate(g: Omit<Gate, 'id' | 'created' | 'resolve'>, timeoutMs?: number): Promise<Outcome> {
  const id = randomUUID().slice(0, 8);
  const cfg = loadConfig();
  const timeout = timeoutMs ?? (g.kind === 'handoff' ? cfg.handoff.timeout_minutes : cfg.approve.timeout_minutes) * 60000;
  const browser = D.browsers.get(g.browserId);
  let shown: Shown | undefined;
  let reminder: ReturnType<typeof setTimeout> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const outcome = await new Promise<Outcome>((resolve) => {
    const gate: Gate = { ...g, id, created: Date.now(), resolve };
    D.gates.set(id, gate);
    const who = label(g.session);
    const site = host(g.url);
    const summary = g.kind === 'handoff' ? `${who} needs you` : `${who} asks to go ahead`;
    const body = g.kind === 'handoff'
      ? `${g.title} on ${site}${g.what ? ` (${g.what})` : ''}. Do it in the browser, then press Done.`
      : `${g.title} on ${site}${g.what ? `: ${g.what}` : ''}${g.why ? `\n${who}: ${g.why}` : ''}`;
    const actions: Record<string, string> = g.kind === 'handoff'
      ? { open: 'Show me', done: 'Done', declined: "I won't" }
      : { open: 'Show me', approved: 'Allow', denied: 'Deny' };
    const onAction = (key: string) => {
      if (key === 'open' || key === 'default') { void bringForward(g); return; }
      if (key === 'done') settle(id, 'handoff-done');
      else if (key === 'declined') settle(id, 'handoff-declined');
      else if (key === 'approved' || key === 'denied') settle(id, key);
    };
    // 1. The notification, the moment the wait starts.
    shown = notify({ title: summary, body, urgency: 'critical', actions, onAction });
    // 2. The tab, with the "Your turn" card.
    browser?.client.ui.show.mutate({
      tab: g.tab, focus: g.kind === 'handoff',
      state: { mode: 'waiting', id, kind: g.kind, session: g.session, title: g.title, what: g.what, detail: g.reason, why: g.why },
    }).catch(() => {});
    if (g.kind === 'handoff') void bringForward(g, false);
    // 3. A reminder, then give up.
    if (g.kind === 'handoff' && cfg.handoff.reminder_minutes > 0) {
      reminder = setTimeout(() => {
        const again = notify({ title: `${who} is still waiting for you`, body, urgency: 'critical', actions, onAction, replaceId: shown?.id });
        const first = shown; shown = { close: () => { first?.close(); again.close(); }, id: again.id };
      }, cfg.handoff.reminder_minutes * 60000);
    }
    timer = setTimeout(() => settle(id, 'timeout'), timeout);
  });

  clearTimeout(reminder); clearTimeout(timer);
  shown?.close();
  D.gates.delete(id);
  // Back to "acting" (the step continues or the act call returns and clears it).
  browser?.client.ui.show.mutate({ tab: g.tab, state: { mode: 'acting', session: g.session } }).catch(() => {});
  log({ session: g.session, gate: g.kind, url: g.url, title: g.title, what: g.what, outcome });
  return outcome;
}

export function settle(id: string, outcome: Outcome) {
  const g = D.gates.get(id);
  if (!g) return false;
  D.gates.delete(id);
  g.resolve(outcome);
  return true;
}

export function settleAll(outcome: Outcome) {
  for (const id of [...D.gates.keys()]) settle(id, outcome);
}

async function bringForward(g: Omit<Gate, 'id' | 'created' | 'resolve'>, focusTab = true) {
  const b = D.browsers.get(g.browserId);
  if (!b) return;
  try {
    if (focusTab) await b.client.tabs.focus.mutate({ tab: g.tab });
    const tab = await b.client.tabs.get.query({ tab: g.tab });
    await focusWindow(b.hello.kind, tab.title);
  } catch { /* not on sway, or the window is gone */ }
}
