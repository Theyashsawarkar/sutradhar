// The page as a tree of what matters: landmarks, headings, text, and every
// control with a ref. One line per node, indented by nesting.

import {
  allElements, deepQueryAll, describe, elementForRef, hasBox, INTERACTIVE, isVisible, looksClickable, nameOf, refFor,
  renderedChildren, roleOf, statesOf, textOf, valueOf,
} from './dom.ts';

export interface SnapshotOptions {
  /** Only controls (and their containers), no text. */
  interactive?: boolean;
  /** Only what is inside the viewport (with a margin). */
  viewport?: boolean;
  /** Start from this ref instead of <body>. */
  root?: string;
  maxChars?: number;
}

export interface FrameSlot { index: number; src: string; ref: string }

const STRUCTURE = new Set(['navigation', 'main', 'banner', 'contentinfo', 'complementary', 'form', 'dialog', 'alertdialog',
  'list', 'table', 'row', 'group', 'region', 'tablist', 'menu', 'menubar', 'tree', 'grid', 'toolbar', 'radiogroup', 'search', 'article']);
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link']);

export function snapshot(opts: SnapshotOptions = {}): { text: string; frames: FrameSlot[]; truncated: boolean } {
  const lines: string[] = [];
  const frames: FrameSlot[] = [];
  let iframeIndex = 0;
  const max = opts.maxChars ?? 60000;
  let size = 0;
  let truncated = false;
  const vh = innerHeight, vw = innerWidth;
  const margin = 200;

  const push = (depth: number, s: string) => {
    if (truncated) return;
    const line = '  '.repeat(depth) + '- ' + s;
    size += line.length + 1;
    if (size > max) { truncated = true; return; }
    lines.push(line);
  };

  const inViewport = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.bottom >= -margin && r.top <= vh + margin && r.right >= -margin && r.left <= vw + margin;
  };

  const walk = (node: Node, depth: number) => {
    if (truncated) return;
    if (node.nodeType === Node.TEXT_NODE) {
      if (opts.interactive) return;
      const t = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (t) push(depth, `text: ${t.length > 400 ? t.slice(0, 397) + '…' : t}`);
      return;
    }
    if (!(node instanceof Element)) {
      if (node instanceof ShadowRoot || node instanceof DocumentFragment) for (const c of Array.from(node.childNodes)) walk(c, depth);
      return;
    }
    const el = node;
    if (SKIP_TAGS.has(el.localName)) return;
    if (!isVisible(el)) return;
    let role = roleOf(el);
    if (!role && looksClickable(el) && hasBox(el)) role = 'clickable';

    if (INTERACTIVE.has(role) && hasBox(el)) {
      if (opts.viewport && !inViewport(el)) return;
      const ref = refFor(el);
      let line = role;
      const name = nameOf(el);
      if (name) line += ` "${name}"`;
      line += ` [ref=${ref}]`;
      const st = statesOf(el);
      if (st.length) line += ` [${st.join(', ')}]`;
      const v = valueOf(el);
      if (v !== undefined) line += ` value="${v}"`;
      if (role === 'link') {
        const href = (el as HTMLAnchorElement).getAttribute('href');
        if (href && !href.startsWith('javascript:')) line += ` → ${href.length > 120 ? href.slice(0, 117) + '…' : href}`;
      }
      if (role === 'iframe') {
        frames.push({ index: iframeIndex, src: (el as HTMLIFrameElement).src, ref });
        line += ` {{frame:${iframeIndex++}}}`;
      }
      if (el.localName === 'input' && (el as HTMLInputElement).type === 'file') line += ' [file upload]';
      push(depth, line);
      // Options of a select, items of a listbox: worth listing.
      if (el.localName === 'select') {
        const opts2 = Array.from((el as HTMLSelectElement).options).slice(0, 50);
        for (const o of opts2) push(depth + 1, `option "${o.textContent?.trim()}"${o.selected ? ' [selected]' : ''}`);
        if ((el as HTMLSelectElement).options.length > 50) push(depth + 1, `…${(el as HTMLSelectElement).options.length - 50} more options`);
        return;
      }
      // Controls with controls inside (a menu item holding a checkbox) keep walking; plain ones stop.
      const inner = el.querySelector('a[href],button,input,select,textarea,[role=button],[role=link],[role=checkbox],[contenteditable=true]');
      if (inner && role !== 'textbox') for (const c of renderedChildren(el)) walk(c, depth + 1);
      return;
    }

    if (role === 'heading') {
      if (opts.interactive) return;
      if (opts.viewport && !inViewport(el)) return;
      push(depth, `heading "${nameOf(el)}" [${statesOf(el).join(', ')}]`);
      return;
    }
    if (role === 'img') {
      if (opts.interactive) return;
      if (opts.viewport && !inViewport(el)) return;
      const n = nameOf(el);
      if (n) push(depth, `img "${n}"`);
      return;
    }

    let childDepth = depth;
    if (STRUCTURE.has(role) && !opts.viewport) {
      const n = nameOf(el);
      const st = statesOf(el).filter((s) => s !== 'focused');
      if (role !== 'row' || !opts.interactive) {
        push(depth, `${role}${n && role !== 'list' && role !== 'row' && role !== 'table' ? ` "${n.slice(0, 80)}"` : ''}${st.length ? ` [${st.join(', ')}]` : ''}`);
        childDepth = depth + 1;
      }
    } else if (role === 'listitem' || role === 'cell' || role === 'columnheader') {
      if (!opts.interactive) {
        // Short items read best on one line.
        const t = textOf(el).replace(/\s+/g, ' ').trim();
        const hasControls = el.querySelector('a[href],button,input,select,textarea,[role=button],[role=link],[tabindex]');
        if (!hasControls && t.length <= 200) {
          if (t && (!opts.viewport || inViewport(el))) push(depth, `${role === 'listitem' ? 'listitem' : role}: ${t}`);
          return;
        }
      }
    }
    for (const c of renderedChildren(el)) walk(c, childDepth);
  };

  let root: Node = document.body ?? document.documentElement;
  if (opts.root) {
    const el = elementForRef(opts.root);
    if (!el) throw new Error(`ref ${opts.root} is gone; take a new snapshot`);
    root = el;
  }
  if (root === document.body || root === document.documentElement) {
    const header = `page "${document.title}" ${location.href}`;
    lines.push('- ' + header);
    for (const c of renderedChildren(root as Element)) walk(c, 1);
  } else {
    walk(root, 0);
  }
  const dlg = document.querySelector('dialog[open], [role=dialog][aria-modal=true], [role=alertdialog]');
  if (dlg && !opts.root) lines.push(`- note: a dialog is open: ${describe(dlg)}`);
  if (truncated) lines.push(`- note: cut at ${max} characters; use root=<ref>, interactive=true or viewport=true to see the rest`);
  return { text: lines.join('\n'), frames, truncated };
}

// ------------------------------------------------------------------ find
// (allElements walks shadow roots too, so text targets reach web components.)
export interface Match { ref: string; what: string; text?: string }

export function find(query: string, opts: { role?: string; limit?: number } = {}): Match[] {
  const q = query.toLowerCase().trim();
  const limit = opts.limit ?? 20;
  const exact: Match[] = [];
  const partial: Match[] = [];
  let selectorMatches: Element[] = [];
  try { selectorMatches = /^[#.\[]|^[a-z]+[#.\[:]/i.test(query) ? deepQueryAll(document, query) : []; } catch { /* not a selector */ }
  for (const el of allElements(document)) {
    if (!isVisible(el) || !hasBox(el)) continue;
    let role = roleOf(el);
    if (!role && looksClickable(el)) role = 'clickable';
    if (opts.role && role !== opts.role) continue;
    const name = nameOf(el).toLowerCase();
    const interactive = INTERACTIVE.has(role);
    if (selectorMatches.includes(el)) { exact.push({ ref: refFor(el), what: describe(el) }); continue; }
    if (!interactive && role !== 'heading' && role !== 'img') {
      // Plain text: match the smallest element holding the words.
      if (!q || el.children.length > 0) continue;
      const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (t.toLowerCase().includes(q)) partial.push({ ref: refFor(el), what: describe(el), text: t.slice(0, 160) });
      continue;
    }
    if (!q) { exact.push({ ref: refFor(el), what: describe(el) }); continue; }
    if (name === q || role === q) exact.push({ ref: refFor(el), what: describe(el) });
    else if (name.includes(q) || (el.getAttribute('placeholder') ?? '').toLowerCase().includes(q) || (el.getAttribute('name') ?? '').toLowerCase() === q)
      partial.push({ ref: refFor(el), what: describe(el) });
    if (exact.length >= limit) break;
  }
  return [...exact, ...partial].slice(0, limit);
}

/** The element a Target means, in this frame. */
export function locate(t: { ref?: string; selector?: string; text?: string; x?: number; y?: number }): Element | undefined {
  if (t.ref) {
    const ref = t.ref.includes(':') ? t.ref.split(':')[1] : t.ref;
    const el = elementForRef(ref);
    if (!el) throw new Error(`ref ${t.ref} is gone (the page changed); take a new snapshot`);
    return el;
  }
  if (t.selector) {
    return document.querySelector(t.selector) ?? deepQueryAll(document, t.selector)[0];
  }
  if (t.text) {
    const m = find(t.text, { limit: 1 });
    return m.length ? elementForRef(m[0].ref) : undefined;
  }
  if (t.x !== undefined && t.y !== undefined) {
    let el = document.elementFromPoint(t.x, t.y) ?? undefined;
    // Into open/closed shadow roots.
    while (el) {
      const sr = (el as any).openOrClosedShadowRoot ?? el.shadowRoot;
      const inner = sr?.elementFromPoint?.(t.x, t.y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }
  return undefined;
}
