// What the user sees on a page an agent is using: an accent border and a
// "sutradhar is working here · Stop" pill while it acts; a yellow border and a
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
  box-shadow: inset 0 0 0 3px var(--c), inset 0 0 26px 2px color-mix(in srgb, var(--c) 55%, transparent), inset 0 0 70px 8px color-mix(in srgb, var(--c) 22%, transparent);
  animation: breathe 2.6s ease-in-out infinite; }
@keyframes breathe {
  0%, 100% { box-shadow: inset 0 0 0 3px var(--c), inset 0 0 22px 1px color-mix(in srgb, var(--c) 45%, transparent), inset 0 0 60px 6px color-mix(in srgb, var(--c) 16%, transparent); }
  50% { box-shadow: inset 0 0 0 4px var(--c), inset 0 0 36px 4px color-mix(in srgb, var(--c) 70%, transparent), inset 0 0 110px 14px color-mix(in srgb, var(--c) 30%, transparent); } }
/* A light running along the top edge: work in progress. */
.sweep { position: fixed; left: 0; right: 0; top: 0; height: 3px; z-index: 2147483647; pointer-events: none; overflow: hidden; border-radius: 0 0 3px 3px; }
.sweep::after { content: ""; position: absolute; top: 0; bottom: 0; width: 34%; border-radius: 3px;
  background: linear-gradient(90deg, transparent, var(--c), #f5e0dc, var(--c), transparent); animation: sweep 1.6s linear infinite; }
@keyframes sweep { from { transform: translateX(-100%); } to { transform: translateX(300%); } }
.waiting .frame { animation-duration: 1.4s; }
@media (prefers-reduced-motion: reduce) { .frame, .sweep::after, .dot { animation: none !important; } }
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
  if (s.mode === 'acting') { const sweep = document.createElement('div'); sweep.className = 'sweep'; wrap.appendChild(sweep); }
  else wrap.classList.add('waiting');
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
// A second pointer, sutradhar's, that moves like a person's hand on a mouse:
// it glides to what it is about to touch, takes the shape the page asks for
// (a hand over links and buttons, a text cursor over fields), presses on
// clicks, and says what it is doing in its name tag. It lives in the
// browser's top layer, above modal dialogs, and never takes clicks.
let cursorHost: HTMLElement | null = null;
let cursorRoot: ShadowRoot | null = null;
let cursorEl: HTMLElement | null = null;
let shapeEl: HTMLElement | null = null;
let tagEl: HTMLElement | null = null;
let ringEl: HTMLElement | null = null;
let chipEl: HTMLElement | null = null;
let pos = { x: -1, y: -1 };
let shape: Shape = 'arrow';
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let tagTimer: ReturnType<typeof setTimeout> | undefined;
let chipTimer: ReturnType<typeof setTimeout> | undefined;

type Shape = 'arrow' | 'hand' | 'text';

// Each shape with its hotspot (the pixel that "points"), like a real cursor theme.
const SHAPES: Record<Shape, { svg: string; hx: number; hy: number }> = {
  arrow: { hx: 4, hy: 3, svg: '<svg viewBox="0 0 28 32" width="28" height="32" xmlns="http://www.w3.org/2000/svg"><path d="M4 3 L4 25 L9.8 19.6 L14 29 L18.6 27 L14.4 17.8 L22 17.8 Z" fill="#1e1e2e" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/><path d="M6.2 8.2 L6.2 20 L9.4 17 L11.6 15.8 L17 15.8 Z" fill="#cba6f7" opacity=".55"/></svg>' },
  hand: { hx: 11, hy: 3, svg: '<svg viewBox="0 0 30 32" width="30" height="32" xmlns="http://www.w3.org/2000/svg"><path d="M11 3.5c1.4 0 2.4 1 2.4 2.4v8.3l1-.1c1.1-.1 2 .5 2.3 1.4.5-.4 1.1-.6 1.8-.5 1 .1 1.8.8 2 1.7.5-.3 1.1-.4 1.7-.3 1.3.2 2.2 1.3 2.2 2.6v4.6c0 3.9-3 7-6.8 7h-3.4c-2.2 0-4.2-1-5.5-2.8l-4.7-6.2c-.7-1-.5-2.4.5-3.1.9-.6 2.1-.5 2.8.3l1.3 1.4V5.9c0-1.4 1-2.4 2.4-2.4z" fill="#1e1e2e" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 16.5v5M17.6 17.2v4.3M21.2 18v3.6" stroke="#cba6f7" stroke-width="1.4" stroke-linecap="round"/></svg>' },
  text: { hx: 8, hy: 13, svg: '<svg viewBox="0 0 16 26" width="16" height="26" xmlns="http://www.w3.org/2000/svg"><path d="M4 2.5h3a2 2 0 0 1 1 .4 2 2 0 0 1 1-.4h3M8 3v20M4 23.5h3a2 2 0 0 0 1-.4 2 2 0 0 0 1 .4h3M5.5 13h5" fill="none" stroke="#ffffff" stroke-width="4" stroke-linecap="round"/><path d="M4 2.5h3a2 2 0 0 1 1 .4 2 2 0 0 1 1-.4h3M8 3v20M4 23.5h3a2 2 0 0 0 1-.4 2 2 0 0 0 1 .4h3M5.5 13h5" fill="none" stroke="#1e1e2e" stroke-width="1.8" stroke-linecap="round"/></svg>' },
};

const POINTER_CSS = `
:host { all: initial; }
.cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none; will-change: transform;
  transition: transform .42s cubic-bezier(.3,.7,.2,1), opacity .35s; filter: drop-shadow(0 2px 3px rgba(0,0,0,.45)) drop-shadow(0 0 6px rgba(203,166,247,.55)); }
.shape { position: absolute; left: 0; top: 0; transform-origin: var(--hx) var(--hy); transition: transform .12s ease-out; }
.shape svg { display: block; }
.press .shape { transform: scale(.82); }
.tag { position: absolute; left: 24px; top: 26px; padding: 2px 10px 3px; border-radius: 999px; background: #cba6f7; color: #1e1e2e;
  font: 600 11.5px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; white-space: nowrap; max-width: 340px; overflow: hidden; text-overflow: ellipsis;
  box-shadow: 0 2px 6px rgba(0,0,0,.35); transition: max-width .25s; }
.tag b { font-weight: 700; }
.chip { position: absolute; left: 24px; top: 50px; padding: 3px 9px; border-radius: 8px; background: #1e1e2e; color: #f5e0dc;
  border: 1px solid #cba6f7; font: 600 12px/1.4 ui-monospace, "JetBrains Mono", monospace; white-space: nowrap; opacity: 0; transition: opacity .2s; }
.chip.on { opacity: 1; }
.ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 36px; height: 36px; margin: -18px 0 0 -18px;
  border-radius: 50%; border: 2px solid #cba6f7; background: rgba(203,166,247,.25); animation: ripple .55s ease-out forwards; }
@keyframes ripple { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.5); opacity: 0; } }
.focusring { position: fixed; z-index: 2147483645; pointer-events: none; border-radius: 8px;
  box-shadow: 0 0 0 2px #cba6f7, 0 0 16px rgba(203,166,247,.55); transition: all .25s, opacity .3s; }
@media (prefers-reduced-motion: reduce) { .cursor { transition: opacity .2s; } .ripple { display: none; } }
`;

function ensureCursor() {
  if (cursorRoot && cursorHost?.isConnected) return cursorRoot;
  cursorHost = topLayerHost('sutradhar-pointer');
  cursorRoot = cursorHost.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = POINTER_CSS;
  cursorEl = document.createElement('div');
  cursorEl.className = 'cursor';
  cursorEl.style.opacity = '0';
  shapeEl = document.createElement('div');
  shapeEl.className = 'shape';
  tagEl = document.createElement('span');
  tagEl.className = 'tag';
  tagEl.textContent = 'sutradhar';
  chipEl = document.createElement('span');
  chipEl.className = 'chip';
  cursorEl.append(shapeEl, tagEl, chipEl);
  setShape('arrow', true);
  ringEl = document.createElement('div');
  ringEl.className = 'focusring';
  ringEl.style.opacity = '0';
  cursorRoot.append(style, ringEl, cursorEl);
  raise(cursorHost);
  return cursorRoot;
}

function setShape(next: Shape, force = false) {
  if (!shapeEl || (next === shape && !force)) return;
  shape = next;
  const s = SHAPES[next];
  shapeEl.innerHTML = s.svg;
  shapeEl.style.setProperty('--hx', `${s.hx}px`);
  shapeEl.style.setProperty('--hy', `${s.hy}px`);
  shapeEl.style.transform = '';
  shapeEl.style.left = `${-s.hx + 4}px`;
  shapeEl.style.top = `${-s.hy + 3}px`;
}

/** The shape the page would give a real pointer here (its CSS cursor, or what the element is). */
function shapeAt(x: number, y: number): Shape {
  let el = document.elementFromPoint(x, y);
  while (el) {
    const sr = (el as any).openOrClosedShadowRoot ?? el.shadowRoot;
    const inner = sr?.elementFromPoint?.(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  if (!el) return 'arrow';
  const c = getComputedStyle(el).cursor;
  if (c === 'pointer' || c === 'grab' || c === 'grabbing') return 'hand';
  if (c === 'text' || c === 'vertical-text') return 'text';
  if (c !== 'auto') return 'arrow';
  const h = el as HTMLElement;
  if (h.isContentEditable || el.closest('input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=range]):not([type=color]):not([type=file]), textarea')) return 'text';
  if (el.closest('a[href], button, [role=button], [role=link], summary, select, label, [role=menuitem], [role=tab], [role=option]')) return 'hand';
  return 'arrow';
}

function place(x: number, y: number) {
  // The cursor element's origin is the hotspot: shapes are offset inside it.
  cursorEl!.style.transform = `translate(${x - 4}px, ${y - 3}px)`;
}

/** Says what sutradhar is doing, on its name tag. */
export function caption(text?: string, ms = 2600) {
  if (!tagEl) return;
  clearTimeout(tagTimer);
  if (!text) { tagEl.textContent = 'sutradhar'; return; }
  tagEl.innerHTML = '';
  const b = document.createElement('b'); b.textContent = 'sutradhar';
  tagEl.append(b, document.createTextNode(` · ${text}`));
  tagTimer = setTimeout(() => { if (tagEl) tagEl.textContent = 'sutradhar'; }, ms);
}

/** A key chip under the pointer: "⏎ Enter", "Ctrl + A". */
export function keyChip(keys: string) {
  if (window.top !== window || document.hidden) return;
  ensureCursor();
  clearTimeout(hideTimer);
  cursorEl!.style.opacity = '1';
  const names: Record<string, string> = { Enter: '⏎ Enter', Return: '⏎ Enter', Tab: '⇥ Tab', Escape: 'Esc', Backspace: '⌫ Backspace', Delete: 'Del',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Control: 'Ctrl', Meta: 'Super', Shift: '⇧ Shift', ' ': 'Space' };
  chipEl!.textContent = keys.split('+').map((k) => names[k] ?? (k.length === 1 ? k.toUpperCase() : k)).join(' + ');
  chipEl!.classList.add('on');
  clearTimeout(chipTimer);
  chipTimer = setTimeout(() => chipEl?.classList.remove('on'), 1300);
}

/**
 * Glides the pointer to (x, y) in viewport pixels and resolves when it is
 * there. `from` is where it was on the previous page (after a navigation),
 * so it never pops up out of nowhere.
 */
export async function moveCursor(x: number, y: number, opts: { click?: boolean; label?: string; from?: { x: number; y: number }; rect?: { x: number; y: number; width: number; height: number } } = {}) {
  if (window.top !== window || document.hidden) return;
  ensureCursor();
  raise(host); raise(cursorHost);
  clearTimeout(hideTimer);
  if (pos.x < 0) {
    // First move on this page: start where the pointer last was (or the middle), without a jump.
    const start = opts.from && opts.from.x >= 0 ? opts.from : { x: innerWidth / 2, y: innerHeight / 2 };
    cursorEl!.style.transition = 'none';
    place(start.x, start.y);
    pos = { ...start };
    void cursorEl!.offsetWidth;
  }
  cursorEl!.style.opacity = '1';
  if (opts.label) caption(opts.label);
  const far = Math.hypot(x - pos.x, y - pos.y);
  const ms = far < 2 ? 0 : Math.min(620, 220 + far * 0.42);
  cursorEl!.style.transition = `transform ${ms}ms cubic-bezier(.3,.7,.2,1), opacity .35s`;
  place(x, y);
  pos = { x, y };
  if (opts.rect) {
    Object.assign(ringEl!.style, { left: `${opts.rect.x - 3}px`, top: `${opts.rect.y - 3}px`, width: `${opts.rect.width + 6}px`, height: `${opts.rect.height + 6}px`, opacity: '1' });
  } else ringEl!.style.opacity = '0';
  // The shape changes as it arrives, like a real pointer crossing onto a link.
  setTimeout(() => setShape(shapeAt(x, y)), Math.max(0, ms - 90));
  await new Promise((r) => setTimeout(r, ms + 50));
  if (opts.click) {
    cursorEl!.classList.add('press');
    const ripple = document.createElement('div');
    ripple.className = 'ripple';
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    cursorRoot!.appendChild(ripple);
    setTimeout(() => ripple.remove(), 650);
    await new Promise((r) => setTimeout(r, 110));
    cursorEl!.classList.remove('press');
  }
}

/** Where the pointer is now (kept by the background across page loads). */
export function cursorPos() { return pos.x < 0 ? null : { ...pos }; }

/** Fades the pointer out after a long quiet spell; it stays where it was. */
export function restCursor(delay = 8000) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (cursorEl) cursorEl.style.opacity = '0';
    if (ringEl) ringEl.style.opacity = '0';
  }, delay);
}
