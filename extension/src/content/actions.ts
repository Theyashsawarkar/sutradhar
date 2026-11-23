// Doing things in the page. On Chrome the background sends real input
// through CDP and only asks this file to find, scroll to and check the
// element; on Firefox/Zen these synthetic events are the input.

import { describe, hasBox, isEditable, isSecretField, isVisible, refFor, roleOf } from './dom.ts';
import { locate } from './snapshot.ts';
import { stepRisk, type Risk, type RiskConfig } from './risk.ts';

const W: any = (window as any).wrappedJSObject ?? window; // page compartment on Firefox
const cloneInto: any = (globalThis as any).cloneInto ?? ((x: unknown) => x);
const pageObj = (o: object) => (W === window ? o : cloneInto(o, W, { wrapReflectors: true }));

export interface Prepared {
  ref: string; x: number; y: number; what: string; risk: Risk;
  editable: boolean; secret: boolean; tag: string; inputType?: string;
  checked?: boolean; draggable: boolean; disabled: boolean; covered?: string;
  rect: { x: number; y: number; width: number; height: number };
  /** For links: where they go and whether they open a new tab. */
  href?: string; newTab?: boolean;
}

// Background tabs throttle animation frames (to once a minute or less): never wait on one alone.
const raf = () => new Promise<void>((r) => { const t = setTimeout(r, 34); requestAnimationFrame(() => { clearTimeout(t); r(); }); });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function target(t: any): Element {
  const el = locate(t);
  if (!el) throw new Error(`no element matches ${JSON.stringify(t)}; take a snapshot or use find`);
  return el;
}

export async function prepare(t: any, kind: string, cfg: RiskConfig, force = false): Promise<Prepared> {
  let el = target(t);
  const atPoint = t.x !== undefined && t.y !== undefined && !t.ref && !t.selector && !t.text;
  if (!atPoint) {
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
    }
    // Wait for it to stop moving (animations, lazy layout).
    let last = el.getBoundingClientRect();
    for (let i = 0; i < 10; i++) {
      await raf();
      const now = el.getBoundingClientRect();
      if (now.x === last.x && now.y === last.y && now.width === last.width && now.height === last.height) break;
      last = now;
    }
  }
  if (!force && !atPoint) {
    if (!isVisible(el) || !hasBox(el)) {
      // A hidden native checkbox/radio styled by its label: act on the label.
      const label = (el as HTMLInputElement).labels?.[0];
      if (label && isVisible(label) && hasBox(label)) el = label;
      else throw new Error(`${describe(el)} is not visible`);
    }
  }
  const r = el.getBoundingClientRect();
  const x = atPoint ? t.x : Math.round(r.left + Math.min(r.width / 2, Math.max(1, r.width - 2)));
  const y = atPoint ? t.y : Math.round(r.top + Math.min(r.height / 2, Math.max(1, r.height - 2)));
  const coverOf = (px: number, py: number) => {
    const hit = deepHit(px, py);
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el) && !(el as HTMLInputElement).labels?.length) {
      const label = hit.closest('label');
      const forMe = label && ((label as HTMLLabelElement).control === el);
      if (!forMe && !isShadowRelated(hit, el)) return describe(hit);
    }
    return undefined;
  };
  let covered: string | undefined;
  if (!atPoint) {
    covered = coverOf(x, y);
    if (covered) {
      // Often a sticky header or a toolbar over the element: centre it and look again.
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
      await raf(); await raf();
      const r2 = el.getBoundingClientRect();
      const x2 = Math.round(r2.left + r2.width / 2), y2 = Math.round(r2.top + r2.height / 2);
      covered = coverOf(x2, y2);
      if (!covered) {
        return { ...(await prepare(t, kind, cfg, true)), covered: undefined };
      }
    }
  }
  const disabled = !!((el as any).disabled || el.getAttribute('aria-disabled') === 'true');
  const input = el as HTMLInputElement;
  return {
    ref: refFor(el), x, y, what: describe(el), risk: stepRisk(kind, el, cfg),
    editable: isEditable(el), secret: isSecretField(el), tag: el.localName,
    inputType: el.localName === 'input' ? input.type : undefined,
    checked: el.localName === 'input' && (input.type === 'checkbox' || input.type === 'radio') ? input.checked
      : el.getAttribute('aria-checked') ? el.getAttribute('aria-checked') === 'true' : undefined,
    draggable: !!el.closest('[draggable=true]'), disabled, covered,
    rect: { x: r.left, y: r.top, width: r.width, height: r.height },
    ...linkInfo(el),
  };
}

function linkInfo(el: Element): { href?: string; newTab?: boolean } {
  const a = el.closest('a[href]') as HTMLAnchorElement | null;
  if (!a || a.href.startsWith('javascript:')) return {};
  return { href: a.href, newTab: a.target === '_blank' || a.target === '_new' };
}

function deepHit(x: number, y: number): Element | null {
  let el = document.elementFromPoint(x, y);
  while (el) {
    const sr = (el as any).openOrClosedShadowRoot ?? el.shadowRoot;
    const inner = sr?.elementFromPoint?.(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

function isShadowRelated(a: Element, b: Element) {
  const host = (n: Node) => (n.getRootNode() as ShadowRoot).host;
  return host(a) === b || host(b) === a || (host(a) && host(a) === host(b));
}

// ------------------------------------------------------------------ synthetic mouse
function mouse(el: Element, type: string, x: number, y: number, button = 0, detail = 1, mods: string[] = []) {
  const init = {
    bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y,
    button, buttons: type.endsWith('down') ? 1 << (button === 2 ? 1 : button === 1 ? 2 : 0) : 0, detail,
    ctrlKey: mods.includes('Control'), shiftKey: mods.includes('Shift'), altKey: mods.includes('Alt'), metaKey: mods.includes('Meta'),
    view: W,
  };
  const Ctor = type.startsWith('pointer') ? W.PointerEvent : W.MouseEvent;
  const extra = type.startsWith('pointer') ? { pointerId: 1, pointerType: 'mouse', isPrimary: true } : {};
  el.dispatchEvent(new Ctor(type, pageObj({ ...init, ...extra })));
}

export function synthHover(el: Element, x: number, y: number) {
  for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) mouse(el, t, x, y);
}

export function synthClick(el: Element, x: number, y: number, button: 'left' | 'right' | 'middle' = 'left', count = 1, mods: string[] = []) {
  const b = button === 'right' ? 2 : button === 'middle' ? 1 : 0;
  const hit = deepHit(x, y);
  const t = hit && (el.contains(hit) || hit.contains(el)) ? hit : el;
  synthHover(t, x, y);
  for (let i = 1; i <= count; i++) {
    mouse(t, 'pointerdown', x, y, b, i, mods);
    mouse(t, 'mousedown', x, y, b, i, mods);
    if (i === 1) focusable(t)?.focus({ preventScroll: true } as FocusOptions);
    mouse(t, 'pointerup', x, y, b, i, mods);
    mouse(t, 'mouseup', x, y, b, i, mods);
    if (b === 0) {
      // .click() runs the element's activation (links, checkboxes, submit) like a real click.
      if (mods.length === 0 && i === 1 && typeof (t as HTMLElement).click === 'function') (t as HTMLElement).click();
      else mouse(t, 'click', x, y, b, i, mods);
    } else if (b === 1) mouse(t, 'auxclick', x, y, b, i, mods);
  }
  if (count === 2 && b === 0) mouse(t, 'dblclick', x, y, b, 2, mods);
  if (b === 2) mouse(t, 'contextmenu', x, y, b, 1, mods);
}

function focusable(el: Element): HTMLElement | null {
  return (el.closest('a[href],button,input,select,textarea,[tabindex],[contenteditable=true],summary') as HTMLElement | null);
}

// ------------------------------------------------------------------ typing
export function focusEnd(el: Element) {
  const h = el as HTMLInputElement;
  h.focus({ preventScroll: true } as FocusOptions);
  if (el.localName === 'input' || el.localName === 'textarea') {
    try { const n = h.value.length; h.setSelectionRange(n, n); } catch { /* email/number inputs */ }
  } else if (h.isContentEditable) {
    const sel = getSelection(); const range = document.createRange();
    range.selectNodeContents(el); range.collapse(false); sel?.removeAllRanges(); sel?.addRange(range);
  }
}

export function selectAllIn(el: Element) {
  const h = el as HTMLInputElement;
  h.focus({ preventScroll: true } as FocusOptions);
  if (el.localName === 'input' || el.localName === 'textarea') { try { h.select(); } catch { /* */ } }
  else if (h.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); getSelection()?.removeAllRanges(); getSelection()?.addRange(r); }
}

const nativeSetter = (el: Element) => {
  const proto = el.localName === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  return Object.getOwnPropertyDescriptor(proto, 'value')?.set;
};

export function synthClear(el: Element) {
  selectAllIn(el);
  if (!document.execCommand('delete')) {
    nativeSetter(el)?.call(el, '');
    el.dispatchEvent(new W.Event('input', pageObj({ bubbles: true })));
  }
  el.dispatchEvent(new W.Event('change', pageObj({ bubbles: true })));
}

export async function synthType(el: Element, text: string) {
  focusEnd(el);
  for (const ch of text) {
    if (ch === '\n') { synthKey(el, 'Enter'); continue; }
    key(el, 'keydown', ch); key(el, 'keypress', ch);
    // execCommand inserts like real typing: beforeinput/input fire and frameworks see it.
    if (!document.execCommand('insertText', false, ch)) {
      const i = el as HTMLInputElement;
      if (el.localName === 'input' || el.localName === 'textarea') {
        const start = i.selectionStart ?? i.value.length, end = i.selectionEnd ?? i.value.length;
        nativeSetter(el)?.call(el, i.value.slice(0, start) + ch + i.value.slice(end));
        try { i.setSelectionRange(start + 1, start + 1); } catch { /* */ }
      } else (el as HTMLElement).textContent += ch;
      el.dispatchEvent(new W.InputEvent('input', pageObj({ bubbles: true, data: ch, inputType: 'insertText' })));
    }
    key(el, 'keyup', ch);
    // A small human pace in a visible tab; none in a hidden one, where timers are throttled to ~1/s.
    if (text.length < 200 && !document.hidden) await sleep(2);
  }
  el.dispatchEvent(new W.Event('change', pageObj({ bubbles: true })));
}

function key(el: Element, type: string, k: string, code?: string, mods: string[] = []) {
  el.dispatchEvent(new W.KeyboardEvent(type, pageObj({
    key: k, code: code ?? (k.length === 1 ? (/[a-z]/i.test(k) ? 'Key' + k.toUpperCase() : /\d/.test(k) ? 'Digit' + k : '') : k),
    bubbles: true, cancelable: true, composed: true,
    ctrlKey: mods.includes('Control'), shiftKey: mods.includes('Shift'), altKey: mods.includes('Alt'), metaKey: mods.includes('Meta'),
  })));
}

/** Synthetic key press, emulating what the browser itself would do for it. */
export function synthKey(el: Element | null, chord: string) {
  const parts = chord.split('+');
  const k = parts.pop()!;
  const mods = parts.map((m) => ({ ctrl: 'Control', cmd: 'Meta', super: 'Meta', option: 'Alt' } as Record<string, string>)[m.toLowerCase()] ?? m);
  const t = el ?? document.activeElement ?? document.body;
  const okDown = t.dispatchEvent(new W.KeyboardEvent('keydown', pageObj({ key: k, code: k, bubbles: true, cancelable: true, composed: true,
    ctrlKey: mods.includes('Control'), shiftKey: mods.includes('Shift'), altKey: mods.includes('Alt'), metaKey: mods.includes('Meta') })));
  if (okDown && !mods.length) {
    const tag = t.localName;
    if (k === 'Enter') {
      if (tag === 'input') { const f = (t as HTMLInputElement).form; if (f) f.requestSubmit(); }
      else if (tag === 'textarea' || (t as HTMLElement).isContentEditable) document.execCommand('insertParagraph') || document.execCommand('insertText', false, '\n');
      else if (tag === 'a' || tag === 'button' || tag === 'summary') (t as HTMLElement).click();
    } else if (k === 'Backspace') document.execCommand('delete');
    else if (k === 'Delete') document.execCommand('forwardDelete');
    else if (k === 'Tab') moveFocus(t, mods.includes('Shift') ? -1 : 1);
    else if (k === ' ' && (tag === 'button' || (tag === 'input' && ['checkbox', 'radio'].includes((t as HTMLInputElement).type)))) (t as HTMLElement).click();
  } else if (okDown && mods.includes('Control') && k.toLowerCase() === 'a' && isEditable(t)) selectAllIn(t);
  t.dispatchEvent(new W.KeyboardEvent('keyup', pageObj({ key: k, code: k, bubbles: true, composed: true })));
}

function moveFocus(from: Element, dir: number) {
  const all = Array.from(document.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"]),[contenteditable=true]'))
    .filter((e) => !(e as any).disabled && isVisible(e) && hasBox(e));
  const i = all.indexOf(from as HTMLElement);
  all[(i + dir + all.length) % all.length]?.focus();
}

// ------------------------------------------------------------------ forms
export function selectOption(el: Element, values: string[]): string {
  if (el.localName !== 'select') throw new Error(`${describe(el)} is not a <select>; click it and pick the option instead`);
  const s = el as HTMLSelectElement;
  const want = values.map((v) => v.toLowerCase().trim());
  const picked: string[] = [];
  for (const o of Array.from(s.options)) {
    const hit = want.includes(o.value.toLowerCase()) || want.includes((o.textContent ?? '').toLowerCase().trim());
    if (s.multiple) o.selected = hit;
    if (hit) { picked.push(o.textContent!.trim()); if (!s.multiple) { s.value = o.value; break; } }
  }
  if (!picked.length) {
    // Partial label match as a fallback.
    const o = Array.from(s.options).find((o) => want.some((w) => (o.textContent ?? '').toLowerCase().includes(w)));
    if (!o) throw new Error(`no option ${JSON.stringify(values)} in ${describe(el)}; options: ${Array.from(s.options).map((o) => o.textContent?.trim()).join(', ')}`);
    s.value = o.value; picked.push(o.textContent!.trim());
  }
  s.dispatchEvent(new W.Event('input', pageObj({ bubbles: true })));
  s.dispatchEvent(new W.Event('change', pageObj({ bubbles: true })));
  return picked.join(', ');
}

// ------------------------------------------------------------------ scroll
/** The page's main scroller: the document, or (in apps like LinkedIn) the biggest scrolling element. */
function pageScroller(): Element {
  const doc = document.scrollingElement ?? document.documentElement;
  if (doc.scrollHeight > doc.clientHeight + 4) return doc;
  let best: Element = doc, area = 0;
  for (const e of Array.from(document.querySelectorAll('main, [role=main], div, section'))) {
    if (e.scrollHeight <= e.clientHeight + 4) continue;
    const cs = getComputedStyle(e);
    if (!/(auto|scroll)/.test(cs.overflowY)) continue;
    const a = e.clientWidth * e.clientHeight;
    if (a > area) { area = a; best = e; }
  }
  return best;
}

export function scroll(el: Element | undefined, direction?: string, amount?: number | 'page' | 'end') {
  const scroller = el ? scrollableOf(el) : pageScroller();
  if (el && !direction) { el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior }); return 'scrolled into view'; }
  const dir = direction ?? 'down';
  const page = dir === 'left' || dir === 'right' ? (scroller.clientWidth || innerWidth) : (scroller.clientHeight || innerHeight);
  let px = amount === 'page' || amount === undefined ? page * 0.85 : amount === 'end' ? 1e9 : amount;
  if (dir === 'up' || dir === 'left') px = -px;
  const before = [scroller.scrollLeft, scroller.scrollTop];
  if (dir === 'left' || dir === 'right') scroller.scrollBy({ left: px, behavior: 'instant' as ScrollBehavior });
  else scroller.scrollBy({ top: px, behavior: 'instant' as ScrollBehavior });
  const moved = scroller.scrollLeft !== before[0] || scroller.scrollTop !== before[1];
  return moved ? `scrolled to ${Math.round(scroller.scrollTop)}/${scroller.scrollHeight - scroller.clientHeight}` : 'already at the end';
}

function scrollableOf(el: Element): Element {
  let e: Element | null = el;
  while (e && e !== document.body) {
    const cs = getComputedStyle(e);
    if (/(auto|scroll)/.test(cs.overflowY + cs.overflowX) && (e.scrollHeight > e.clientHeight || e.scrollWidth > e.clientWidth)) return e;
    e = e.parentElement;
  }
  return pageScroller();
}

// ------------------------------------------------------------------ drag and drop, files
function makeDataTransfer(files: { name: string; mime: string; b64: string }[] = []) {
  const dt = new W.DataTransfer();
  for (const f of files) {
    const bin = atob(f.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const pageBytes = W === window ? bytes : cloneInto(bytes, W);
    dt.items.add(new W.File(W === window ? [pageBytes] : cloneInto([pageBytes], W), f.name, pageObj({ type: f.mime })));
  }
  return dt;
}

function dragEvent(el: Element, type: string, x: number, y: number, dt: any) {
  el.dispatchEvent(new W.DragEvent(type, pageObj({ bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt })));
}

export async function synthDrag(from: Element, to: Element, fx: number, fy: number, tx: number, ty: number) {
  if (from.closest('[draggable=true]')) {
    const dt = new W.DataTransfer();
    dragEvent(from, 'dragstart', fx, fy, dt);
    dragEvent(to, 'dragenter', tx, ty, dt);
    dragEvent(to, 'dragover', tx, ty, dt);
    dragEvent(to, 'drop', tx, ty, dt);
    dragEvent(from, 'dragend', tx, ty, dt);
    return 'dragged (HTML5)';
  }
  mouse(from, 'pointerdown', fx, fy); mouse(from, 'mousedown', fx, fy);
  for (let i = 1; i <= 8; i++) {
    const x = fx + ((tx - fx) * i) / 8, y = fy + ((ty - fy) * i) / 8;
    const over = document.elementFromPoint(x, y) ?? to;
    mouse(over, 'pointermove', x, y); mouse(over, 'mousemove', x, y);
    await sleep(16);
  }
  mouse(to, 'pointerup', tx, ty); mouse(to, 'mouseup', tx, ty);
  return 'dragged (mouse)';
}

export function upload(el: Element, files: { name: string; mime: string; b64: string }[]) {
  const dt = makeDataTransfer(files);
  if (el.localName === 'input' && (el as HTMLInputElement).type === 'file') {
    (el as HTMLInputElement).files = dt.files;
    el.dispatchEvent(new W.Event('input', pageObj({ bubbles: true })));
    el.dispatchEvent(new W.Event('change', pageObj({ bubbles: true })));
    return `${files.length} file(s) set on ${describe(el)}`;
  }
  // A file input hidden behind a styled button/label?
  const inner = el.querySelector('input[type=file]') ?? (el as HTMLLabelElement).control;
  if (inner && (inner as HTMLInputElement).type === 'file') return upload(inner, files);
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  for (const t of ['dragenter', 'dragover', 'drop']) dragEvent(el, t, x, y, dt);
  return `${files.length} file(s) dropped on ${describe(el)}`;
}

// ------------------------------------------------------------------ waiting
export async function waitFor(t: { ref?: string; selector?: string; text?: string; gone?: boolean; timeout?: number }, signalStop: () => boolean) {
  const deadline = Date.now() + (t.timeout ?? 10000);
  const present = () => {
    try {
      if (t.ref || t.selector) { const el = locate(t); return !!el && isVisible(el) && hasBox(el); }
      if (t.text) return (document.body?.innerText ?? '').toLowerCase().includes(t.text.toLowerCase());
    } catch { return false; }
    return true;
  };
  while (Date.now() < deadline && !signalStop()) {
    if (present() !== !!t.gone) return true;
    await sleep(100);
  }
  return false;
}

export { roleOf };
