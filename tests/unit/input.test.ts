import { describe, expect, it } from 'vitest';
import { keyDef, parseChord } from '../../extension/src/background/keys.ts';
import { chordArgs, toScreen } from '../../packages/daemon/src/osinput.ts';

describe('keys', () => {
  it('parses chords', () => {
    expect(parseChord('Control+Shift+t')).toEqual({ mods: ['Control', 'Shift'], key: 't' });
    expect(parseChord('ctrl+a')).toEqual({ mods: ['Control'], key: 'a' });
    expect(parseChord('Enter')).toEqual({ mods: [], key: 'Enter' });
    expect(() => parseChord('Hyper+x')).toThrow();
  });
  it('knows key codes', () => {
    expect(keyDef('Enter')).toMatchObject({ code: 'Enter', keyCode: 13 });
    expect(keyDef('a')).toMatchObject({ code: 'KeyA', keyCode: 65, text: 'a' });
    expect(keyDef('!')).toMatchObject({ code: 'Digit1' });
    expect(keyDef('esc').key).toBe('Escape');
  });
  it('turns chords into wtype arguments', () => {
    expect(chordArgs('Control+l')).toEqual(['-M', 'ctrl', 'l', '-m', 'ctrl']);
    expect(chordArgs('Return')).toEqual(['-k', 'Return']);
    expect(chordArgs('Enter')).toEqual(['-k', 'Return']);
    expect(chordArgs('Shift+Tab')).toEqual(['-M', 'shift', '-k', 'Tab', '-m', 'shift']);
  });
});

describe('page → screen coordinates', () => {
  const win = { rect: { x: 0, y: 27, width: 1280, height: 873 }, window_rect: { x: 2, y: 0, width: 1276, height: 871 } };
  it('uses Firefox’s inner screen offset minus its window shadow (measured in Zen on sway)', () => {
    const g = { innerScreenX: 206, innerScreenY: 28, screenX: 0, screenY: 0, innerWidth: 1082, innerHeight: 855, outerWidth: 1316, outerHeight: 911, dpr: 1 } as any;
    expect(toScreen(win as any, g, 74, 361)).toEqual({ x: 262, y: 396 });
  });
  it('scales by devicePixelRatio over the output scale', () => {
    const g = { innerScreenX: 10, innerScreenY: 10, screenX: 0, screenY: 0, innerWidth: 500, innerHeight: 400, outerWidth: 638, outerHeight: 435.5, dpr: 2 } as any;
    expect(toScreen(win as any, g, 10, 10, 'viewport', 1)).toEqual({ x: 42, y: 67 });
    const g2 = { ...g, outerWidth: 1276, outerHeight: 871 };
    expect(toScreen(win as any, g2, 10, 10, 'viewport', 2)).toEqual({ x: 22, y: 47 });
  });
});
