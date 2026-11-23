// Real mouse and keyboard, for what an extension can't reach: the browser's
// own menus and address bar, permission prompts, file pickers, and pages that
// ignore synthetic events. Uses sway's own seat commands for the pointer and
// wtype (virtual keyboard) for keys; both need the browser window focused.

import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { promisify } from 'node:util';
import { withPointer, type Layout, type VirtualPointer } from './wayland.ts';

const run = promisify(execFile);

function swaySock() {
  if (process.env.SWAYSOCK) return process.env.SWAYSOCK;
  const dir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`;
  const s = readdirSync(dir).find((f) => /^sway-ipc\..*\.sock$/.test(f));
  if (!s) throw new Error('sway is not running (OS input needs sway)');
  return `${dir}/${s}`;
}

async function sway(...args: string[]) {
  if (process.env.SUTRADHAR_NO_OS_INPUT) throw new Error('OS input is off (SUTRADHAR_NO_OS_INPUT)');
  const { stdout } = await run('swaymsg', ['-s', swaySock(), ...args], { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

// Same-engine browsers can report each other's names (Zen says "Firefox"), so match the family.
const GECKO = /zen|firefox|librewolf|floorp|waterfox/i;
const CHROMIUM = /chrom|brave|edge|vivaldi|opera/i;
const APP_IDS: Record<string, RegExp> = { zen: GECKO, firefox: GECKO, other: GECKO, chrome: CHROMIUM, chromium: CHROMIUM, brave: CHROMIUM, edge: CHROMIUM };

interface Node { id: number; name?: string; app_id?: string | null; window_properties?: { class?: string }; focused: boolean; visible?: boolean; rect: R; window_rect: R; nodes: Node[]; floating_nodes: Node[]; pid?: number }
interface R { x: number; y: number; width: number; height: number }

export interface Geometry {
  innerWidth: number; innerHeight: number; outerWidth: number; outerHeight: number; dpr: number;
  innerScreenX?: number; innerScreenY?: number; screenX: number; screenY: number; tabTitle: string; title: string; windowFocused: boolean; active: boolean;
}

export async function findWindow(kind: string, title: string): Promise<Node> {
  const tree = JSON.parse(await sway('-t', 'get_tree')) as Node;
  const re = APP_IDS[kind] ?? /./;
  const wins: Node[] = [];
  const walk = (n: Node) => {
    if ((n.app_id || n.window_properties) && (re.test(n.app_id ?? '') || re.test(n.window_properties?.class ?? ''))) wins.push(n);
    for (const c of [...(n.nodes ?? []), ...(n.floating_nodes ?? [])]) walk(c);
  };
  walk(tree);
  if (!wins.length) throw new Error(`no ${kind} window found in sway`);
  const t = title.slice(0, 40);
  const byTitle = wins.filter((w) => t && (w.name ?? '').includes(t));
  const pool = byTitle.length ? byTitle : wins;
  return pool.find((w) => w.focused) ?? pool.find((w) => w.visible) ?? pool[0];
}

/**
 * The focused window, if it is one of the browser's own dialogs (a file
 * picker, a print or permission dialog): keys must go there, not to the page.
 */
export async function browserDialogFocused(kind: string): Promise<Node | null> {
  const tree = JSON.parse(await sway('-t', 'get_tree')) as Node;
  let found: Node | null = null;
  const walk = (n: Node) => {
    if (n.focused && (n.app_id || n.window_properties)) found = n;
    for (const c of [...(n.nodes ?? []), ...(n.floating_nodes ?? [])]) walk(c);
  };
  walk(tree);
  if (!found) return null;
  const f = found as Node;
  const app = `${f.app_id ?? ''} ${f.window_properties?.class ?? ''}`;
  const engine = APP_IDS[kind] ?? /./;
  const isPortal = /portal|zenity|kdialog|gtk-file|file-chooser/i.test(app);
  const ownTitle = engine.test(f.name ?? '') && !engine.test(app);
  return isPortal || ownTitle ? f : null;
}

export async function focusWindow(kind: string, title: string) {
  const w = await findWindow(kind, title);
  if (!w.focused) await sway(`[con_id=${w.id}] focus`);
  return w;
}

/**
 * Page (viewport) CSS pixels → sway layout coordinates. CSS pixels become
 * layout pixels by devicePixelRatio / output scale. Browsers that draw their
 * own window shadows (Firefox, Zen) report an outer size bigger than the
 * window sway shows; that margin is split evenly around it.
 */
export function toScreen(w: Node, g: Geometry, x: number, y: number, relative: 'viewport' | 'window' = 'viewport', outputScale = 1) {
  const content = { x: w.rect.x + w.window_rect.x, y: w.rect.y + w.window_rect.y, width: w.window_rect.width, height: w.window_rect.height };
  const f = (g.dpr || 1) / (outputScale || 1);
  const insetX = Math.max(0, (g.outerWidth * f - content.width) / 2);
  const insetY = Math.max(0, (g.outerHeight * f - content.height) / 2);
  if (relative === 'window') return { x: Math.round(content.x + x * f), y: Math.round(content.y + y * f) };
  let offX: number, offY: number;
  if (g.innerScreenX !== undefined && g.innerScreenY !== undefined && g.innerScreenX !== null) {
    offX = (g.innerScreenX - g.screenX) * f - insetX;
    offY = (g.innerScreenY - g.screenY) * f - insetY;
  } else {
    offX = ((g.outerWidth - g.innerWidth) / 2) * f - insetX;
    offY = (g.outerHeight - g.innerHeight) * f - 2 * insetY;
  }
  return { x: Math.round(content.x + offX + x * f), y: Math.round(content.y + offY + y * f) };
}

/** The scale of the output a window is on. */
export async function outputScale(w: Node): Promise<number> {
  try {
    const outs = JSON.parse(await sway('-t', 'get_outputs')) as { active: boolean; scale: number; rect: R }[];
    const cx = w.rect.x + w.rect.width / 2, cy = w.rect.y + w.rect.height / 2;
    const o = outs.find((o) => o.active && cx >= o.rect.x && cx < o.rect.x + o.rect.width && cy >= o.rect.y && cy < o.rect.y + o.rect.height);
    return o?.scale ?? 1;
  } catch { return 1; }
}

const BUTTON: Record<string, string> = { left: 'button1', middle: 'button2', right: 'button3' };

/** The bounding box of every active output: what absolute pointer motion spans. */
async function layout(): Promise<Layout> {
  const outs = JSON.parse(await sway('-t', 'get_outputs')) as { active: boolean; rect: R }[];
  const act = outs.filter((o) => o.active);
  const x = Math.min(...act.map((o) => o.rect.x)), y = Math.min(...act.map((o) => o.rect.y));
  const r = Math.max(...act.map((o) => o.rect.x + o.rect.width)), b = Math.max(...act.map((o) => o.rect.y + o.rect.height));
  return { x, y, width: r - x, height: b - y };
}

/**
 * Pointer actions go through a virtual pointer device (works even with no
 * mouse attached); if the compositor lacks that protocol, through sway's
 * own seat cursor commands.
 */
async function pointerDo(fn: (p: VirtualPointer) => Promise<void>, fallback: () => Promise<void>) {
  try {
    await withPointer(await layout(), fn);
  } catch (e) {
    if (/virtual pointer|Wayland display/.test(String(e))) await fallback();
    else throw e;
  }
}

export async function pointer(at: { x: number; y: number }) {
  await pointerDo((p) => p.move(at.x, at.y), () => sway('seat', '-', 'cursor', 'set', String(at.x), String(at.y)).then(() => {}));
}

export async function click(at: { x: number; y: number }, button = 'left', count = 1) {
  await pointerDo(async (p) => { await p.move(at.x, at.y); await new Promise((r) => setTimeout(r, 60)); await p.click(button, count); }, async () => {
    await sway('seat', '-', 'cursor', 'set', String(at.x), String(at.y));
    for (let i = 0; i < count; i++) {
      await sway('seat', '-', 'cursor', 'press', BUTTON[button] ?? 'button1');
      await sway('seat', '-', 'cursor', 'release', BUTTON[button] ?? 'button1');
    }
  });
}

export async function drag(a: { x: number; y: number }, b: { x: number; y: number }) {
  await pointerDo(async (p) => {
    await p.move(a.x, a.y);
    await p.button('left', true);
    for (let i = 1; i <= 10; i++) {
      await p.move(a.x + ((b.x - a.x) * i) / 10, a.y + ((b.y - a.y) * i) / 10);
      await new Promise((r) => setTimeout(r, 20));
    }
    await p.button('left', false);
  }, async () => {
    await sway('seat', '-', 'cursor', 'set', String(a.x), String(a.y));
    await sway('seat', '-', 'cursor', 'press', 'button1');
    await sway('seat', '-', 'cursor', 'set', String(b.x), String(b.y));
    await sway('seat', '-', 'cursor', 'release', 'button1');
  });
}

export async function wheel(at: { x: number; y: number }, direction: 'up' | 'down', notches = 3) {
  await pointerDo(async (p) => { await p.move(at.x, at.y); await p.wheel(direction, notches); }, async () => {
    await sway('seat', '-', 'cursor', 'set', String(at.x), String(at.y));
    for (let i = 0; i < notches; i++) {
      const b = direction === 'up' ? 'button4' : 'button5';
      await sway('seat', '-', 'cursor', 'press', b);
      await sway('seat', '-', 'cursor', 'release', b);
    }
  });
}

const KEYSYM: Record<string, string> = {
  enter: 'Return', return: 'Return', backspace: 'BackSpace', tab: 'Tab', escape: 'Escape', esc: 'Escape', delete: 'Delete',
  space: 'space', ' ': 'space', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', up: 'Up', down: 'Down',
  left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next', insert: 'Insert',
};
const MOD: Record<string, string> = { control: 'ctrl', ctrl: 'ctrl', shift: 'shift', alt: 'alt', meta: 'logo', super: 'logo', cmd: 'logo' };

/** "Control+l" → wtype arguments. */
export function chordArgs(chord: string): string[] {
  const parts = chord.split('+').map((s) => s.trim()).filter((s, i, a) => s || i === a.length - 1);
  const key = parts.pop() || '+';
  const mods = parts.map((m) => { const x = MOD[m.toLowerCase()]; if (!x) throw new Error(`unknown modifier ${m}`); return x; });
  const args: string[] = [];
  for (const m of mods) args.push('-M', m);
  const sym = KEYSYM[key.toLowerCase()] ?? (/^F\d{1,2}$/i.test(key) ? key.toUpperCase() : key.length === 1 ? null : key);
  if (sym) args.push('-k', sym); else args.push(key);
  for (const m of mods.reverse()) args.push('-m', m);
  return args;
}

const offGuard = () => { if (process.env.SUTRADHAR_NO_OS_INPUT) throw new Error('OS input is off (SUTRADHAR_NO_OS_INPUT)'); };
// A fresh virtual keyboard drops its first key until the compositor has its keymap: wait a moment first.
export async function keys(chord: string) { offGuard(); await run('wtype', ['-s', '120', ...chordArgs(chord)]); }
export async function typeText(text: string) { offGuard(); await run('wtype', ['-s', '120', '-d', '4', '--', text]); }
