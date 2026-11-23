// Key names → what CDP's Input.dispatchKeyEvent needs.

export interface KeyDef { key: string; code: string; keyCode: number; text?: string }

const named: Record<string, KeyDef> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91 },
};
for (let i = 1; i <= 12; i++) named[`F${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

const aliases: Record<string, string> = {
  return: 'Enter', esc: 'Escape', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  pgup: 'PageUp', pgdn: 'PageDown', ctrl: 'Control', control: 'Control', cmd: 'Meta', super: 'Meta', win: 'Meta',
  option: 'Alt', alt: 'Alt', shift: 'Shift', meta: 'Meta', space: 'Space', ' ': 'Space',
};

const shifted: Record<string, string> = { '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  _: '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`' };
const punct: Record<string, [string, number]> = { '-': ['Minus', 189], '=': ['Equal', 187], '[': ['BracketLeft', 219], ']': ['BracketRight', 221],
  '\\': ['Backslash', 220], ';': ['Semicolon', 186], "'": ['Quote', 222], ',': ['Comma', 188], '.': ['Period', 190], '/': ['Slash', 191], '`': ['Backquote', 192] };

export function keyDef(name: string): KeyDef {
  const n = named[name] ?? named[aliases[name.toLowerCase()] ?? ''];
  if (n) return n;
  if (name.length === 1) {
    const c = name;
    if (/[a-z]/i.test(c)) return { key: c, code: 'Key' + c.toUpperCase(), keyCode: c.toUpperCase().charCodeAt(0), text: c };
    if (/\d/.test(c)) return { key: c, code: 'Digit' + c, keyCode: c.charCodeAt(0), text: c };
    const base = shifted[c] ?? c;
    if (/\d/.test(base)) return { key: c, code: 'Digit' + base, keyCode: base.charCodeAt(0), text: c };
    const p = punct[base];
    if (p) return { key: c, code: p[0], keyCode: p[1], text: c };
    return { key: c, code: '', keyCode: 0, text: c };
  }
  throw new Error(`unknown key "${name}"`);
}

export const MOD_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

/** "Control+Shift+t" → modifiers and the key. */
export function parseChord(chord: string): { mods: string[]; key: string } {
  const parts = chord.split('+').map((s) => s.trim());
  // "Control++" means the plus key.
  if (chord.endsWith('++')) { parts.splice(parts.length - 2, 2, '+'); }
  const key = parts.pop() || '+';
  const mods = parts.map((m) => {
    const a = aliases[m.toLowerCase()] ?? m;
    if (!(a in MOD_BITS)) throw new Error(`unknown modifier "${m}" in "${chord}"`);
    return a;
  });
  return { mods, key };
}
