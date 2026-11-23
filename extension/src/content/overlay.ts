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
.cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none;
  transition: transform .42s cubic-bezier(.3,.7,.2,1), opacity .3s; filter: drop-shadow(0 2px 4px rgba(0,0,0,.4)); }
.cursor svg { display: block; }
.tag { position: absolute; left: 22px; top: 24px; padding: 2px 9px 3px; border-radius: 999px; background: #cba6f7; color: #1e1e2e;
  font: 600 11.5px/1.4 system-ui, sans-serif; white-space: nowrap; box-shadow: 0 1px 3px rgba(0,0,0,.3); }
.ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 34px; height: 34px; margin: -17px 0 0 -17px;
  border-radius: 50%; border: 2px solid #cba6f7; background: rgba(203,166,247,.22); animation: ripple .5s ease-out forwards; }
@keyframes ripple { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.4); opacity: 0; } }
.focusring { position: fixed; z-index: 2147483645; pointer-events: none; border-radius: 8px;
  box-shadow: 0 0 0 2px #cba6f7, 0 0 14px rgba(203,166,247,.45); transition: all .25s; }
.brand { font-size: 11px; color: #7f849c; margin-top: 8px; }
`;

/**
 * Pages draw modal dialogs in the browser's top layer, above everything else
 * (LinkedIn's composer is one). A manual popover lives in that layer too, and
 * the last one shown is on top, so our elements are popovers raised again
 * every time they change.
 */
export function raise(el: HTMLElement | null) {
  if (!el) return;
  const anyEl = el as any;
  if (typeof anyEl.showPopover !== 'function') return;
  try { if (el.matches(':popover-open')) anyEl.hidePopover(); anyEl.showPopover(); } catch { /* not connected yet */ }
}

function topLayerHost(tag: string) {
  const h = document.createElement(tag);
  h.setAttribute('popover', 'manual');
  // Undo the popover's default box: we position our own children.
  h.style.cssText = 'all: initial; position: fixed; inset: 0; width: 0; height: 0; margin: 0; padding: 0; border: 0; background: transparent; overflow: visible; pointer-events: none; display: block;';
  (document.documentElement ?? document.body).appendChild(h);
  return h;
}

function ensure() {
  if (root && host?.isConnected) { raise(host); return root; }
  host = topLayerHost('sutradhar-overlay');
  root = host.attachShadow({ mode: 'closed' });
  raise(host);
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
    // The user sees sutradhar at work, never which agent is behind it.
    const label = document.createElement('span'); label.textContent = 'sutradhar is working here';
    pill.append(dot, label, button('Stop', 'stop', () => ext.runtime.sendMessage({ type: 'stop' })));
    wrap.appendChild(pill);
  } else {
    const card = document.createElement('div');
    card.className = 'card';
    const h = document.createElement('h1');
    h.textContent = s.kind === 'handoff' ? 'Your turn' : 'sutradhar asks to go ahead';
    const p = document.createElement('p'); p.textContent = s.title;
    card.append(h, p);
    if (s.what) { const w = document.createElement('p'); w.className = 'what'; w.textContent = s.what; card.appendChild(w); }
    if (s.detail) { const d = document.createElement('p'); d.textContent = s.detail; card.appendChild(d); }
    if (s.why) { const y = document.createElement('p'); y.className = 'why'; y.textContent = `Why: ${s.why}`; card.appendChild(y); }
    const row = document.createElement('div'); row.className = 'row';
    const send = (outcome: string) => ext.runtime.sendMessage({ type: 'resolve', id: s.id, outcome });
    if (s.kind === 'handoff') row.append(button("I won't", 'no', () => send('declined')), button('Done', 'go', () => send('done')));
    else row.append(button('Deny', 'no', () => send('denied')), button('Allow', 'go', () => send('approved')));
    card.appendChild(row);
    const brand = document.createElement('div'); brand.className = 'brand';
    brand.textContent = s.kind === 'handoff' ? 'sutradhar is waiting for you' : 'sutradhar';
    card.appendChild(brand);
    wrap.appendChild(card);
  }
  r.appendChild(wrap);
}

// ------------------------------------------------------------------ the visible pointer
// A pointer that glides to what sutradhar is about to touch, so the user sees
// the work happen like a person doing it. It lives beside the overlay, in the
// same closed shadow root, and never takes clicks.
let cursorHost: HTMLElement | null = null;
let cursorRoot: ShadowRoot | null = null;
let cursorEl: HTMLElement | null = null;
let ringEl: HTMLElement | null = null;
let pos = { x: -40, y: -40 };
let hideTimer: ReturnType<typeof setTimeout> | undefined;

const POINTER = '<svg viewBox="0 0 26 30" width="30" height="35" xmlns="http://www.w3.org/2000/svg"><path d="M3 2 L3 24 L9 18.5 L13.5 28 L18 26 L13.6 16.8 L21.5 16.8 Z" fill="#cba6f7" stroke="#1e1e2e" stroke-width="2" stroke-linejoin="round"/></svg>';

function ensureCursor() {
  if (cursorRoot && cursorHost?.isConnected) return cursorRoot;
  cursorHost = topLayerHost('sutradhar-pointer');
  cursorRoot = cursorHost.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = CSS;
  cursorEl = document.createElement('div');
  cursorEl.className = 'cursor';
  cursorEl.innerHTML = POINTER + '<span class="tag">sutradhar</span>';
  cursorEl.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
  ringEl = document.createElement('div');
  ringEl.className = 'focusring';
  ringEl.style.opacity = '0';
  cursorRoot.append(style, ringEl, cursorEl);
  raise(cursorHost);
  return cursorRoot;
}

/** Glides the pointer to (x, y) in viewport pixels; resolves when it arrives. */
export async function moveCursor(x: number, y: number, opts: { click?: boolean; rect?: { x: number; y: number; width: number; height: number } } = {}) {
  if (window.top !== window || document.hidden) return;
  const root = ensureCursor();
  // A modal may have opened since: stay above it.
  raise(host); raise(cursorHost);
  clearTimeout(hideTimer);
  cursorEl!.style.opacity = '1';
  const far = Math.hypot(x - pos.x, y - pos.y);
  const ms = pos.x < 0 ? 0 : Math.min(520, 160 + far * 0.45);
  cursorEl!.style.transition = `transform ${ms}ms cubic-bezier(.3,.7,.2,1), opacity .3s`;
  // The arrow's tip is at (3, 2) in its box.
  cursorEl!.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
  pos = { x, y };
  if (opts.rect) {
    Object.assign(ringEl!.style, { left: `${opts.rect.x - 3}px`, top: `${opts.rect.y - 3}px`, width: `${opts.rect.width + 6}px`, height: `${opts.rect.height + 6}px`, opacity: '1' });
  } else ringEl!.style.opacity = '0';
  await new Promise((r) => setTimeout(r, ms + 40));
  if (opts.click) {
    const ripple = document.createElement('div');
    ripple.className = 'ripple';
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    root.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
  }
}

/** Fades the pointer out a little after the work stops. */
export function restCursor(delay = 1800) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (cursorEl) cursorEl.style.opacity = '0';
    if (ringEl) ringEl.style.opacity = '0';
    pos = { x: -40, y: -40 };
  }, delay);
}
