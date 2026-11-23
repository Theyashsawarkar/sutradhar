// Page-level hooks, in the isolated world: alert/confirm/prompt and the
// console. While an agent works in a tab a dialog must never freeze the page
// (an extension can't press a native dialog's buttons), so they are answered
// here and reported; outside agent tabs they pass through untouched.

export interface DialogRecord { kind: string; message: string; answer: string; time: number; url: string }
export interface ConsoleRecord { level: string; text: string; time: number; url: string }

export const state = {
  agent: false,
  /** Answers queued by the `dialog` tool, used first-in first-out. */
  answers: [] as { accept: boolean; text?: string }[],
  dialogs: [] as DialogRecord[],
  console: [] as ConsoleRecord[],
  onDialog: (_d: DialogRecord) => {},
};

export function answerDialog(kind: string, message: string, def?: string): { handled: boolean; value?: unknown } {
  if (!state.agent) return { handled: false };
  const queued = state.answers.shift();
  let value: unknown; let answer: string;
  if (kind === 'alert') { value = undefined; answer = 'OK'; }
  else if (kind === 'confirm') { const ok = queued ? queued.accept : false; value = ok; answer = ok ? 'OK' : 'Cancel (default; call dialog accept=true and repeat the step to say OK)'; }
  else { const ok = queued ? queued.accept : false; value = ok ? (queued?.text ?? def ?? '') : null; answer = ok ? `OK with "${value}"` : 'Cancel (default)'; }
  const rec = { kind, message: String(message ?? ''), answer, time: Date.now(), url: location.href };
  state.dialogs.push(rec);
  if (state.dialogs.length > 50) state.dialogs.shift();
  state.onDialog(rec);
  return { handled: true, value };
}

export function recordConsole(level: string, text: string) {
  state.console.push({ level, text: text.slice(0, 2000), time: Date.now(), url: location.href });
  if (state.console.length > 500) state.console.shift();
}

function fmt(args: unknown[]) {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

/** Chrome: talk to main-world.ts through synchronous DOM events. */
export function listenToMainWorld() {
  document.addEventListener('__sutradhar_q', (e) => {
    let q: any;
    try { q = JSON.parse((e as CustomEvent).detail); } catch { return; }
    if (q.type === 'console') { recordConsole(q.level, q.text); return; }
    if (q.type === 'dialog') {
      const a = answerDialog(q.kind, q.message, q.def);
      document.dispatchEvent(new CustomEvent('__sutradhar_a', { detail: JSON.stringify(a) }));
    }
  });
}

/** Firefox/Zen: replace the page's functions directly with exportFunction. */
export function hookFirefoxPage() {
  const w: any = (window as any).wrappedJSObject;
  const exportFunction: any = (globalThis as any).exportFunction;
  if (!w || !exportFunction) return false;
  for (const kind of ['alert', 'confirm', 'prompt']) {
    const original = w[kind];
    exportFunction(function (message?: string, def?: string) {
      const a = answerDialog(kind, message ?? '', def);
      if (!a.handled) return original.call(w, message, def);
      return a.value;
    }, w, { defineAs: kind });
  }
  const c = w.console;
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = c[level];
    exportFunction(function (...args: unknown[]) {
      try { recordConsole(level, fmt(args)); } catch { /* */ }
      // The page's console must get a page-owned array, or it can't read it.
      const cloneInto = (globalThis as any).cloneInto;
      return original.apply(c, cloneInto(args, w, { cloneFunctions: true, wrapReflectors: true }));
    }, c, { defineAs: level });
  }
  return true;
}

export function listenForErrors() {
  addEventListener('error', (e) => recordConsole('error', `${e.message} (${e.filename}:${e.lineno})`));
  addEventListener('unhandledrejection', (e) => recordConsole('error', `Unhandled rejection: ${String((e as PromiseRejectionEvent).reason)}`));
  // "Leave site?" prompts would block an agent's navigation: silence them in agent tabs.
  addEventListener('beforeunload', (e) => { if (state.agent) e.stopImmediatePropagation(); }, { capture: true });
}
