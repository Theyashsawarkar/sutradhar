// Chrome only: runs in the page's own world at document_start, so it can wrap
// alert/confirm/prompt and the console. It asks the isolated content script
// (hooks.ts) what to do through synchronous DOM events; with no answer it
// behaves exactly like the original.

(() => {
  const w = window as any;
  if (w.__sutradharHooked) return;
  Object.defineProperty(w, '__sutradharHooked', { value: true });
  let reply: any;
  document.addEventListener('__sutradhar_a', (e) => {
    try { reply = JSON.parse((e as CustomEvent).detail); } catch { reply = undefined; }
  });
  const ask = (q: object) => {
    reply = undefined;
    document.dispatchEvent(new CustomEvent('__sutradhar_q', { detail: JSON.stringify(q) }));
    return reply;
  };
  for (const kind of ['alert', 'confirm', 'prompt'] as const) {
    const original = w[kind];
    w[kind] = function (message?: unknown, def?: unknown) {
      const a = ask({ type: 'dialog', kind, message: String(message ?? ''), def: def === undefined ? undefined : String(def) });
      if (!a || !a.handled) return original.call(window, message, def);
      return a.value;
    };
  }
  // File pickers: while an upload is armed, the page gets the files and no picker opens.
  const proto = HTMLInputElement.prototype as any;
  for (const name of ['click', 'showPicker']) {
    const original = proto[name];
    if (typeof original !== 'function') continue;
    proto[name] = function (this: HTMLInputElement) {
      if (this.type === 'file') {
        const a = ask({ type: 'filepick' });
        if (a && a.files) {
          const dt = new DataTransfer();
          for (const f of a.files) {
            const bin = atob(f.b64); const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            dt.items.add(new File([bytes], f.name, { type: f.mime }));
          }
          this.files = dt.files;
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return undefined;
        }
      }
      return original.call(this);
    };
  }
  const fmt = (args: unknown[]) => args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level];
    console[level] = function (...args: unknown[]) {
      try { ask({ type: 'console', level, text: fmt(args).slice(0, 2000) }); } catch { /* */ }
      return original.apply(console, args);
    };
  }
})();
