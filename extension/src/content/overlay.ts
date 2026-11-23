// What the user sees on a page an agent is using: an accent border and a
// "claude is acting · Stop" pill while it acts; a yellow border and a
// "Your turn" card while it waits on the user. Lives in a closed shadow root,
// and its buttons only answer real (trusted) clicks, so the page can't press
// them.

declare const chrome: any;
const ext: any = (globalThis as any).browser ?? chrome;

export type OverlayState =
  | { mode: 'idle' }
  | { mode: 'acting'; session: string; label?: string }
  | { mode: 'waiting'; id: string; kind: 'handoff' | 'approve'; session: string; title: string; detail?: string; why?: string; what?: string };

let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;

const CSS = `
:host { all: initial; }
.frame { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; border-radius: 14px;
  box-shadow: inset 0 0 0 3px var(--c), inset 0 0 28px color-mix(in srgb, var(--c) 45%, transparent); transition: box-shadow .2s; }
.pill, .card { position: fixed; z-index: 2147483647; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #cdd6f4; background: #1e1e2e; border: 1px solid color-mix(in srgb, var(--c) 60%, #313244);
  box-shadow: 0 8px 28px rgba(0,0,0,.35); pointer-events: auto; }
.pill { right: 16px; bottom: 16px; border-radius: 999px; padding: 6px 6px 6px 14px; display: flex; gap: 10px; align-items: center; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c); animation: pulse 1.2s infinite; }
@keyframes pulse { 50% { opacity: .35; } }
.card { right: 16px; bottom: 16px; width: min(380px, calc(100vw - 32px)); border-radius: 14px; padding: 14px 16px; }
.card h1 { all: unset; display: block; font-weight: 650; font-size: 14px; color: var(--c); margin-bottom: 6px; }
.card p { margin: 4px 0; }
.card .why { color: #a6adc8; font-size: 12px; }
.card .what { color: #fab387; font-family: ui-monospace, monospace; font-size: 12px; }
.row { display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end; }
button { all: unset; cursor: pointer; border-radius: 999px; padding: 6px 14px; font-weight: 600; font-size: 12.5px; }
.go { background: var(--ok); color: #1e1e2e; }
.no { background: #313244; color: #cdd6f4; }
.stop { background: #f38ba8; color: #1e1e2e; }
button:focus-visible { outline: 2px solid var(--c); outline-offset: 2px; }
.brand { font-size: 11px; color: #7f849c; margin-top: 8px; }
`;

function ensure() {
  if (root && host?.isConnected) return root;
  host = document.createElement('sutradhar-overlay');
  root = host.attachShadow({ mode: 'closed' });
  (document.documentElement ?? document.body).appendChild(host);
  return root;
}

function button(label: string, cls: string, onClick: () => void) {
  const b = document.createElement('button');
  b.textContent = label;
  b.className = cls;
  b.addEventListener('click', (e) => { if (e.isTrusted) onClick(); });
  return b;
}

export function setOverlay(s: OverlayState) {
  if (window.top !== window) return;
  if ('session' in s) s = { ...s, session: s.session.replace(/#\d+$/, '') };
  if (s.mode === 'idle') { host?.remove(); host = null; root = null; return; }
  const r = ensure();
  r.innerHTML = '';
  const style = document.createElement('style');
  style.textContent = CSS;
  r.appendChild(style);
  const wrap = document.createElement('div');
  const color = s.mode === 'acting' ? '#cba6f7' : '#f9e2af';
  wrap.style.setProperty('--c', color);
  wrap.style.setProperty('--ok', '#a6e3a1');
  const frame = document.createElement('div');
  frame.className = 'frame';
  wrap.appendChild(frame);
  if (s.mode === 'acting') {
    const pill = document.createElement('div');
    pill.className = 'pill';
    const dot = document.createElement('span'); dot.className = 'dot';
    const label = document.createElement('span'); label.textContent = `${s.session} is ${s.label ?? 'acting'}`;
    pill.append(dot, label, button('Stop', 'stop', () => ext.runtime.sendMessage({ type: 'stop' })));
    wrap.appendChild(pill);
  } else {
    const card = document.createElement('div');
    card.className = 'card';
    const h = document.createElement('h1');
    h.textContent = s.kind === 'handoff' ? 'Your turn' : `${s.session} asks to go ahead`;
    const p = document.createElement('p'); p.textContent = s.title;
    card.append(h, p);
    if (s.what) { const w = document.createElement('p'); w.className = 'what'; w.textContent = s.what; card.appendChild(w); }
    if (s.detail) { const d = document.createElement('p'); d.textContent = s.detail; card.appendChild(d); }
    if (s.why) { const y = document.createElement('p'); y.className = 'why'; y.textContent = `${s.session}: ${s.why}`; card.appendChild(y); }
    const row = document.createElement('div'); row.className = 'row';
    const send = (outcome: string) => ext.runtime.sendMessage({ type: 'resolve', id: s.id, outcome });
    if (s.kind === 'handoff') row.append(button("I won't", 'no', () => send('declined')), button('Done', 'go', () => send('done')));
    else row.append(button('Deny', 'no', () => send('denied')), button('Allow', 'go', () => send('approved')));
    card.appendChild(row);
    const brand = document.createElement('div'); brand.className = 'brand';
    brand.textContent = s.kind === 'handoff' ? `sutradhar · ${s.session} is waiting for you` : 'sutradhar';
    card.appendChild(brand);
    wrap.appendChild(card);
  }
  r.appendChild(wrap);
}
