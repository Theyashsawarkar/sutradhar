// The content script: one per frame, at document_start. Answers the
// background's requests ({op, args}) about this frame.

import { find, locate, snapshot } from './snapshot.ts';
import { pageMarkdown } from './markdown.ts';
import {
  armFiles, scrollPoint, fileInputFor, filesTaken, focusEnd, focusStart, prepare, scroll, selectAllIn, selectOption, synthClear, synthClick, synthDrag, synthHover, synthKey,
  synthType, target, upload, waitFor,
} from './actions.ts';
import { DEFAULT_RISK, type RiskConfig } from './risk.ts';
import { moveCursor, restCursor, setOverlay } from './overlay.ts';
import { hookFirefoxPage, listenForErrors, listenToMainWorld, state } from './hooks.ts';
import { describe } from './dom.ts';

declare const chrome: any;
const ext: any = (globalThis as any).browser ?? chrome;

if (!(window as any).__sutradharContent) {
  (window as any).__sutradharContent = true;
  start();
}

function start() {
  let risk: RiskConfig = DEFAULT_RISK;
  let stopFlag = 0;
  let mutations = 0;
  if (!hookFirefoxPage()) listenToMainWorld();
  listenForErrors();
  state.onDialog = (d) => { try { ext.runtime.sendMessage({ type: 'event', kind: 'dialog', data: d }); } catch { /* */ } };

  const watch = () => {
    new MutationObserver((list) => { mutations += list.length; }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  };
  if (document.documentElement) watch(); else document.addEventListener('DOMContentLoaded', watch, { once: true });

  // Ask whether this tab belongs to an agent (to arm the dialog guard early).
  ext.runtime.sendMessage({ type: 'hello-frame' }).then((r: any) => {
    if (r?.agent) state.agent = true;
    if (r?.risk) risk = r.risk;
    if (r?.overlay && window.top === window) setOverlay(r.overlay);
  }).catch(() => {});

  const ops: Record<string, (a: any) => unknown> = {
    ping: () => ({ url: location.href, top: window.top === window }),
    mode: (a) => { state.agent = !!a.agent; if (a.risk) risk = a.risk; return true; },
    snapshot: (a) => snapshot(a ?? {}),
    text: (a) => pageMarkdown(a?.maxChars, a?.all),
    find: (a) => find(a.query, a),
    prepare: (a) => prepare(a.target, a.kind, risk, a.force),
    risk: (a) => prepare(a.target, a.kind, risk, true).then((p) => p.risk).catch(() => ({ level: 'none' })),
    click: (a) => { const p = locate(a.target)!; synthClick(p ?? target(a.target), a.x, a.y, a.button, a.count, a.modifiers); return true; },
    hover: (a) => { synthHover(target(a.target), a.x, a.y); return true; },
    type: async (a) => { const el = target(a.target); if (a.clear) synthClear(el); await synthType(el, a.value, a.delay, a.at); return true; },
    clear: (a) => { synthClear(target(a.target)); return true; },
    selectAll: (a) => { selectAllIn(target(a.target)); return true; },
    focusEnd: (a) => { focusEnd(target(a.target)); return true; },
    focusStart: (a) => { focusStart(target(a.target)); return true; },
    focus: (a) => { (target(a.target) as HTMLElement).focus(); return true; },
    key: (a) => { synthKey(a.target ? target(a.target) : null, a.keys); return true; },
    select: (a) => selectOption(target(a.target), Array.isArray(a.value) ? a.value : [a.value]),
    scroll: (a) => scroll(a.target && Object.keys(a.target).length ? target(a.target) : undefined, a.direction, a.amount),
    scrollPoint: (a) => scrollPoint(a.target && Object.keys(a.target).length ? target(a.target) : undefined),
    drag: async (a) => synthDrag(target(a.from), target(a.to), a.fx, a.fy, a.tx, a.ty),
    upload: (a) => upload(target(a.target), a.files),
    hasFileInput: (a) => !!fileInputFor(target(a.target)),
    armFiles: (a) => { armFiles(a.files); return true; },
    filesTaken: () => filesTaken(),
    wait: async (a) => { const mine = stopFlag; return waitFor(a, () => stopFlag !== mine); },
    stop: () => { stopFlag++; return true; },
    changes: () => mutations,
    frameOffset: (a) => frameOffset(a.src, a.index),
    iframes: () => Array.from(document.querySelectorAll('iframe,frame')).map((f) => (f as HTMLIFrameElement).src),
    geometry: () => ({ innerScreenX: (window as any).mozInnerScreenX, innerScreenY: (window as any).mozInnerScreenY, screenX, screenY, innerWidth, innerHeight, outerWidth, outerHeight, dpr: devicePixelRatio, title: document.title,
      scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, scrollX, scrollY }),
    overlay: (a) => { setOverlay(a); if (a?.mode === 'idle') restCursor(); return true; },
    cursor: async (a) => { await moveCursor(a.x, a.y, a); return true; },
    dialogAnswer: (a) => { state.answers.push({ accept: a.accept, text: a.text }); return state.answers.length; },
    dialogs: () => state.dialogs,
    console: (a) => {
      let list = state.console;
      if (a?.pattern) { const re = new RegExp(a.pattern, 'i'); list = list.filter((c) => re.test(c.text) || re.test(c.level)); }
      if (a?.onlyErrors) list = list.filter((c) => c.level === 'error' || c.level === 'warn');
      const out = list.slice(-(a?.limit ?? 100));
      if (a?.clear) state.console.length = 0;
      return out;
    },
    selection: () => getSelection()?.toString() ?? '',
    describe: (a) => describe(target(a.target)),
  };

  ext.runtime.onMessage.addListener((msg: any, _sender: unknown, reply: (r: unknown) => void) => {
    if (!msg || msg.to !== 'content') return false;
    const fn = ops[msg.op];
    if (!fn) { reply({ error: `unknown op ${msg.op}` }); return false; }
    Promise.resolve().then(() => fn(msg.args ?? {})).then(
      (value) => reply({ value }),
      (e) => reply({ error: e instanceof Error ? e.message : String(e) }),
    );
    return true;
  });
}

/** Where a child frame's viewport sits inside this frame's viewport. */
function frameOffset(src: string, index?: number) {
  const frames = Array.from(document.querySelectorAll('iframe,frame')) as HTMLIFrameElement[];
  let f = frames.find((x) => x.src === src);
  if (!f && index !== undefined) f = frames[index];
  if (!f && frames.length === 1) f = frames[0];
  if (!f) return null;
  const r = f.getBoundingClientRect();
  const cs = getComputedStyle(f);
  return {
    x: r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft),
    y: r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop),
  };
}
