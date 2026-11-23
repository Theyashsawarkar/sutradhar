// Reading the DOM the way a person (or a screen reader) sees it: roles,
// accessible names, visibility, refs that point back at elements.

declare const chrome: any;

// ------------------------------------------------------------------ refs
let nextRef = 1;
const byRef = new Map<string, WeakRef<Element>>();
const refOf = new WeakMap<Element, string>();

export function refFor(el: Element): string {
  let r = refOf.get(el);
  if (!r) {
    r = `e${nextRef++}`;
    refOf.set(el, r);
    byRef.set(r, new WeakRef(el));
  }
  return r;
}

export function elementForRef(ref: string): Element | undefined {
  const el = byRef.get(ref)?.deref();
  if (!el) return undefined;
  if (!el.isConnected) { byRef.delete(ref); return undefined; }
  return el;
}

// ------------------------------------------------------------------ shadow DOM
/** Open or closed shadow root (content scripts may see closed ones). */
export function shadowOf(el: Element): ShadowRoot | null {
  const anyEl = el as any;
  if (anyEl.openOrClosedShadowRoot) return anyEl.openOrClosedShadowRoot; // Firefox
  try {
    if (typeof chrome !== 'undefined' && chrome.dom?.openOrClosedShadowRoot) return chrome.dom.openOrClosedShadowRoot(el);
  } catch { /* not a host */ }
  return el.shadowRoot;
}

/** Children as rendered: a shadow host shows its shadow tree, a slot its assigned nodes. */
export function renderedChildren(node: Element | ShadowRoot | Document): Node[] {
  if (node instanceof Element) {
    const sr = shadowOf(node);
    if (sr) return Array.from(sr.childNodes);
    if (node.localName === 'slot') {
      const assigned = (node as HTMLSlotElement).assignedNodes({ flatten: true });
      return assigned.length ? assigned : Array.from(node.childNodes);
    }
  }
  return Array.from(node.childNodes);
}

/** Every element, including those inside open and closed shadow roots. */
export function* allElements(root: Document | ShadowRoot | Element): Generator<Element> {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    yield el;
    const sr = shadowOf(el);
    if (sr) yield* allElements(sr);
  }
}

/** querySelectorAll that also looks inside shadow roots. */
export function deepQueryAll(root: Document | ShadowRoot | Element, selector: string, out: Element[] = []): Element[] {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (el.matches(selector)) out.push(el);
    const sr = shadowOf(el);
    if (sr) deepQueryAll(sr, selector, out);
  }
  return out;
}

// ------------------------------------------------------------------ visibility
export function isVisible(el: Element): boolean {
  if (el.getAttribute('aria-hidden') === 'true') return false;
  if ((el as HTMLElement).hidden) return false;
  const anyEl = el as any;
  if (anyEl.checkVisibility) {
    if (!anyEl.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })) return false;
  } else {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  }
  return true;
}

export function hasBox(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

// ------------------------------------------------------------------ roles
const INPUT_ROLES: Record<string, string> = {
  button: 'button', submit: 'button', reset: 'button', image: 'button',
  checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
  search: 'searchbox', email: 'textbox', tel: 'textbox', text: 'textbox', url: 'textbox',
  password: 'textbox', file: 'button', color: 'button', date: 'textbox', 'datetime-local': 'textbox',
  month: 'textbox', time: 'textbox', week: 'textbox',
};

export function roleOf(el: Element): string {
  const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0];
  if (explicit && explicit !== 'presentation' && explicit !== 'none') return explicit;
  const tag = el.localName;
  switch (tag) {
    case 'a': case 'area': return el.hasAttribute('href') ? 'link' : '';
    case 'button': return 'button';
    case 'summary': return 'button';
    case 'input': {
      const t = ((el as HTMLInputElement).type || 'text').toLowerCase();
      if (t === 'hidden') return '';
      return INPUT_ROLES[t] ?? 'textbox';
    }
    case 'textarea': return 'textbox';
    case 'select': return (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1 ? 'listbox' : 'combobox';
    case 'option': return 'option';
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
    case 'img': return el.getAttribute('alt') === '' ? '' : 'img';
    case 'svg': return el.getAttribute('aria-label') || el.querySelector(':scope > title') ? 'img' : '';
    case 'nav': return 'navigation';
    case 'main': return 'main';
    case 'aside': return 'complementary';
    case 'header': return el.closest('article,section,main') ? '' : 'banner';
    case 'footer': return el.closest('article,section,main') ? '' : 'contentinfo';
    case 'form': return 'form';
    case 'table': return 'table';
    case 'tr': return 'row';
    case 'th': return 'columnheader';
    case 'td': return 'cell';
    case 'ul': case 'ol': return 'list';
    case 'li': return 'listitem';
    case 'dialog': return 'dialog';
    case 'iframe': case 'frame': return 'iframe';
    case 'video': return 'video';
    case 'audio': return 'audio';
    case 'progress': return 'progressbar';
    case 'meter': return 'meter';
    case 'fieldset': return 'group';
    case 'canvas': return 'canvas';
    case 'label': return '';
  }
  if ((el as HTMLElement).isContentEditable && !(el.parentElement as HTMLElement | null)?.isContentEditable) return 'textbox';
  return '';
}

export const INTERACTIVE = new Set([
  'link', 'button', 'checkbox', 'radio', 'textbox', 'searchbox', 'combobox', 'listbox', 'option',
  'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem',
  'gridcell', 'iframe', 'canvas', 'video', 'audio', 'clickable',
]);

/** A div/span that behaves like a button (pointer cursor or tabindex) without saying so. */
export function looksClickable(el: Element): boolean {
  const h = el as HTMLElement;
  if (h.tabIndex >= 0 && h.hasAttribute('tabindex')) return true;
  if (el.hasAttribute('onclick')) return true;
  const cs = getComputedStyle(el);
  if (cs.cursor !== 'pointer') return false;
  const parent = el.parentElement;
  return !parent || getComputedStyle(parent).cursor !== 'pointer';
}

// ------------------------------------------------------------------ names
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

export function textOf(node: Node, depth = 0): string {
  if (depth > 30) return '';
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (!(node instanceof Element)) return '';
  if (['script', 'style', 'noscript', 'template'].includes(node.localName)) return '';
  if (!isVisible(node)) return '';
  if (node.localName === 'img') return node.getAttribute('alt') ?? '';
  if (node.localName === 'br') return ' ';
  let s = '';
  for (const c of renderedChildren(node)) s += textOf(c, depth + 1) + (c instanceof Element && getComputedStyle(c).display.startsWith('block') ? ' ' : '');
  return s;
}

export function nameOf(el: Element): string {
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const root = el.getRootNode() as Document | ShadowRoot;
    const parts = by.split(/\s+/).map((id) => (root.getElementById?.(id) ?? document.getElementById(id))).filter(Boolean) as Element[];
    const s = clean(parts.map((p) => textOf(p)).join(' '));
    if (s) return s;
  }
  const aria = clean(el.getAttribute('aria-label'));
  if (aria) return aria;
  const tag = el.localName;
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const input = el as HTMLInputElement;
    if (['button', 'submit', 'reset'].includes(input.type)) return clean(input.value) || (input.type === 'submit' ? 'Submit' : input.type === 'reset' ? 'Reset' : '');
    if (input.type === 'image') return clean(input.alt) || clean(input.value);
    const labels = (input as any).labels as NodeListOf<HTMLLabelElement> | null;
    if (labels && labels.length) {
      const s = clean(Array.from(labels).map((l) => textOf(l)).join(' '));
      if (s) return s;
    }
    const ph = clean(input.getAttribute('placeholder'));
    if (ph) return ph;
    return clean(el.getAttribute('title')) || clean(input.name);
  }
  if (tag === 'img' || tag === 'area') return clean(el.getAttribute('alt')) || clean(el.getAttribute('title'));
  if (tag === 'svg') return clean(el.querySelector(':scope > title')?.textContent) ;
  if (tag === 'iframe') return clean(el.getAttribute('title')) || clean(el.getAttribute('name'));
  if (tag === 'fieldset') return clean(el.querySelector(':scope > legend')?.textContent);
  if (tag === 'table') return clean(el.querySelector(':scope > caption')?.textContent);
  const role = roleOf(el);
  if (['link', 'button', 'heading', 'option', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem',
    'cell', 'columnheader', 'listitem', 'checkbox', 'radio', 'switch', 'clickable', 'gridcell'].includes(role) || role === '') {
    const t = clean(textOf(el));
    if (t) return t.length > 160 ? t.slice(0, 157) + '…' : t;
  }
  return clean(el.getAttribute('title'));
}

/** `button "Place order"` — for errors, logs and approvals. */
export function describe(el: Element): string {
  const role = roleOf(el) || (looksClickable(el) ? 'clickable' : el.localName);
  const name = nameOf(el);
  return name ? `${role} "${name.slice(0, 80)}"` : role;
}

export function valueOf(el: Element): string | undefined {
  const tag = el.localName;
  if (tag === 'input') {
    const i = el as HTMLInputElement;
    if (['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file'].includes(i.type)) {
      if (i.type === 'file') return i.files?.length ? Array.from(i.files).map((f) => f.name).join(', ') : undefined;
      return undefined;
    }
    if (isSecretField(el)) return i.value ? '[hidden]' : undefined;
    return i.value || undefined;
  }
  if (tag === 'textarea') return (el as HTMLTextAreaElement).value || undefined;
  if (tag === 'select') {
    const s = el as HTMLSelectElement;
    return Array.from(s.selectedOptions).map((o) => clean(o.textContent)).join(', ') || undefined;
  }
  if ((el as HTMLElement).isContentEditable) {
    const t = clean(textOf(el));
    return t ? (t.length > 200 ? t.slice(0, 197) + '…' : t) : undefined;
  }
  if (['slider', 'spinbutton', 'progressbar', 'meter'].includes(roleOf(el))) return el.getAttribute('aria-valuenow') ?? (el as HTMLInputElement).value;
  return undefined;
}

/** Fields whose content the agent must never see or type: passwords, cards, OTPs. */
export function isSecretField(el: Element): boolean {
  if (el.localName !== 'input' && el.localName !== 'textarea' && !(el as HTMLElement).isContentEditable) return false;
  const i = el as HTMLInputElement;
  if (i.type === 'password') return true;
  const ac = (i.getAttribute('autocomplete') ?? '').toLowerCase();
  if (/\b(cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year|one-time-code|current-password|new-password)\b/.test(ac)) return true;
  const hint = [i.name, i.id, i.getAttribute('aria-label'), i.getAttribute('placeholder'), nameOf(el)].join(' ').toLowerCase();
  return SECRET_HINT.test(hint);
}

export const SECRET_HINT = /\b(password|passcode|passwd|cvv|cvc|card ?number|cardnumber|card no|security code|expiry|exp(iry)? ?date|otp|one[- ]?time|verification code|2fa|mfa|totp|\bpin\b|upi ?pin|mpin|iban|account ?number|routing ?number|ifsc|aadhaar|ssn)\b/;

export function statesOf(el: Element): string[] {
  const s: string[] = [];
  const h = el as HTMLInputElement;
  if (el.localName === 'input' && (h.type === 'checkbox' || h.type === 'radio')) s.push(h.checked ? 'checked' : 'unchecked');
  const ac = el.getAttribute('aria-checked');
  if (ac === 'true') s.push('checked'); else if (ac === 'false' && !s.length) s.push('unchecked'); else if (ac === 'mixed') s.push('mixed');
  if (el.getAttribute('aria-pressed') === 'true') s.push('pressed');
  if (el.getAttribute('aria-selected') === 'true' || (el.localName === 'option' && (el as HTMLOptionElement).selected)) s.push('selected');
  const exp = el.getAttribute('aria-expanded');
  if (exp === 'true') s.push('expanded'); else if (exp === 'false') s.push('collapsed');
  if ((h as any).disabled || el.getAttribute('aria-disabled') === 'true') s.push('disabled');
  if ((h as any).required || el.getAttribute('aria-required') === 'true') s.push('required');
  if ((h as any).readOnly && (el.localName === 'input' || el.localName === 'textarea')) s.push('readonly');
  if (el.getAttribute('aria-invalid') === 'true') s.push('invalid');
  if (document.activeElement === el) s.push('focused');
  if (el.localName === 'details' && (el as HTMLDetailsElement).open) s.push('open');
  if (el.localName.match(/^h[1-6]$/)) s.push(`level=${el.localName[1]}`);
  else if (el.getAttribute('aria-level')) s.push(`level=${el.getAttribute('aria-level')}`);
  return s;
}

export function isEditable(el: Element): boolean {
  const tag = el.localName;
  if (tag === 'textarea') return true;
  if (tag === 'input') return !['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'range', 'color', 'hidden'].includes((el as HTMLInputElement).type);
  return (el as HTMLElement).isContentEditable;
}
