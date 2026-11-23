// Chrome only: real (trusted) input, screenshots, PDFs and JS evaluation
// through chrome.debugger. Attached on first use, detached after a quiet
// spell so the "is debugging this browser" bar doesn't linger.

import { keyDef, MOD_BITS, parseChord } from './keys.ts';

declare const chrome: any;

const attached = new Map<number, ReturnType<typeof setTimeout> | null>();
const IDLE_MS = 20000;

export const hasCdp = () => typeof chrome !== 'undefined' && !!chrome.debugger && !(globalThis as any).browser?.runtime?.getBrowserInfo;

async function attach(tabId: number) {
  if (!attached.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (e) {
      if (!String(e).includes('Already attached')) throw e;
    }
    attached.set(tabId, null);
    // A dialog the page hook missed must never freeze input: answer it here.
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable').catch(() => {});
    // sutradhar works in background tabs: have Chrome render and treat this one as focused anyway.
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  }
  const t = attached.get(tabId);
  if (t) clearTimeout(t);
  attached.set(tabId, setTimeout(() => detach(tabId), IDLE_MS));
}

export async function detach(tabId: number) {
  const t = attached.get(tabId);
  if (t) clearTimeout(t);
  attached.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch { /* gone */ }
}

export async function detachAll() {
  await Promise.all([...attached.keys()].map(detach));
}

/** Set by the background: called when CDP had to answer a native dialog. */
export const dialogSeen: { fn: (tabId: number, d: { type: string; message: string }) => { accept: boolean; text?: string } } = {
  fn: (_t, d) => ({ accept: d.type === 'alert' || d.type === 'beforeunload' }),
};

if (hasCdp()) {
  chrome.debugger.onDetach.addListener((src: { tabId?: number }) => { if (src.tabId) attached.delete(src.tabId); });
  chrome.debugger.onEvent.addListener((src: { tabId?: number }, method: string, params: any) => {
    if (method !== 'Page.javascriptDialogOpening' || !src.tabId) return;
    const a = dialogSeen.fn(src.tabId, { type: params.type, message: params.message });
    chrome.debugger.sendCommand({ tabId: src.tabId }, 'Page.handleJavaScriptDialog', { accept: a.accept, promptText: a.text ?? params.defaultPrompt ?? '' }).catch(() => {});
  });
}

export async function send<T = any>(tabId: number, method: string, params: object = {}): Promise<T> {
  await attach(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

const BUTTON = { left: 'left', right: 'right', middle: 'middle' } as const;

function modBits(mods: string[] = []) { return mods.reduce((m, k) => m | (MOD_BITS[k] ?? 0), 0); }

export async function mouseMove(tabId: number, x: number, y: number, mods: string[] = []) {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: modBits(mods) });
}

export async function click(tabId: number, x: number, y: number, button: 'left' | 'right' | 'middle' = 'left', count = 1, mods: string[] = []) {
  const modifiers = modBits(mods);
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
  for (let i = 1; i <= count; i++) {
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: BUTTON[button], clickCount: i, modifiers, buttons: 1 });
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: BUTTON[button], clickCount: i, modifiers });
  }
}

export async function drag(tabId: number, fx: number, fy: number, tx: number, ty: number) {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: fx, y: fy });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: fx, y: fy, button: 'left', clickCount: 1, buttons: 1 });
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: fx + ((tx - fx) * i) / steps, y: fy + ((ty - fy) * i) / steps, button: 'left', buttons: 1 });
    await new Promise((r) => setTimeout(r, 16));
  }
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left', clickCount: 1 });
}

export async function press(tabId: number, chord: string) {
  const { mods, key } = parseChord(chord);
  const def = keyDef(key);
  const modifiers = modBits(mods);
  for (const m of mods) { const d = keyDef(m); await send(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, modifiers }); }
  const text = mods.some((m) => m !== 'Shift') ? undefined : def.text;
  await send(tabId, 'Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown', key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode,
    text, unmodifiedText: text, modifiers,
    // Let Chrome run editing commands for shortcuts (select all, copy, paste…).
    commands: mods.includes('Control') && /^[acvxzy]$/i.test(def.key) ? [{ a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo', y: 'redo' }[def.key.toLowerCase()]] : undefined,
  });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers });
  for (const m of mods.reverse()) { const d = keyDef(m); await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode }); }
}

export async function type(tabId: number, text: string, delay = 0) {
  if (text.length > 300 && !delay) { await send(tabId, 'Input.insertText', { text }); return; }
  for (const ch of text) {
    if (ch === '\n') { await press(tabId, 'Enter'); continue; }
    let def: { key: string; code: string; keyCode: number } | undefined;
    try { def = keyDef(ch); } catch { def = undefined; }
    if (!def || !def.code) { await send(tabId, 'Input.insertText', { text: ch }); continue; }
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: def.code, windowsVirtualKeyCode: def.keyCode, text: ch, unmodifiedText: ch });
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: def.code, windowsVirtualKeyCode: def.keyCode });
    if (delay) await new Promise((r) => setTimeout(r, delay));
  }
}

export async function screenshot(tabId: number, opts: { full?: boolean; clip?: { x: number; y: number; width: number; height: number }; format: 'png' | 'jpeg'; quality?: number; maxWidth?: number }) {
  let clip = opts.clip ? { ...opts.clip, scale: 1 } : undefined;
  if (opts.full) {
    const m = await send(tabId, 'Page.getLayoutMetrics');
    const cs = m.cssContentSize ?? m.contentSize;
    clip = { x: 0, y: 0, width: Math.min(cs.width, 4000), height: Math.min(cs.height, 16000), scale: 1 };
  }
  if (clip && opts.maxWidth && clip.width > opts.maxWidth) clip.scale = opts.maxWidth / clip.width;
  const r = await send(tabId, 'Page.captureScreenshot', {
    format: opts.format, quality: opts.format === 'jpeg' ? opts.quality ?? 80 : undefined,
    clip, captureBeyondViewport: !!opts.full,
  });
  return r.data as string;
}

export async function printPdf(tabId: number) {
  const r = await send(tabId, 'Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
  return r.data as string;
}

export async function evaluate(tabId: number, code: string) {
  const r = await send(tabId, 'Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true, userGesture: true, replMode: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value ?? (r.result?.description ?? null);
}
