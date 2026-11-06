import { describe, expect, it } from 'vitest';
import type { KeyDef } from '../../src/core/catalog.js';
import { CLIPBOARD_CHORDS, MODIFIER, NAMED_CODES, keyForChar } from '../../src/core/keycodes.js';
import { NO_MODS, alternates, keyLabel, modState, press, pressText, type Mods } from '../../src/core/keyboard.js';

const q: KeyDef = { type: 'char', char: 'q' };
const one: KeyDef = { type: 'char', char: '1', shift: '!', fn: { type: 'key', key: 'F1' } };
const backquote: KeyDef = { type: 'char', char: '`', shift: '~', fn: { type: 'key', key: 'Escape' } };
const mod = (m: 'shift' | 'caps' | 'ctrl' | 'alt' | 'super' | 'fn'): KeyDef => ({ type: 'mod', mod: m });
const named = (key: 'Backspace' | 'ArrowLeft' | 'Escape' | 'Delete'): KeyDef => ({ type: 'key', key });

/** Press keys in order, collecting effects. */
const run = (...keys: KeyDef[]) => {
  let mods: Mods = NO_MODS;
  const effects = keys.flatMap((key) => {
    const result = press(mods, key);
    mods = result.mods;
    return result.effects;
  });
  return { mods, effects };
};
const texts = (...keys: KeyDef[]) =>
  run(...keys)
    .effects.map((e) => (e.kind === 'text' ? e.text : `[${e.kind}]`))
    .join('');

describe('typing', () => {
  it('types characters as text', () => {
    expect(run(q, one).effects).toEqual([
      { kind: 'text', text: 'q' },
      { kind: 'text', text: '1' },
    ]);
  });

  it('Shift applies to the next key only; double tap locks it', () => {
    expect(texts(mod('shift'), q, q)).toBe('Qq');
    expect(texts(mod('shift'), mod('shift'), q, one)).toBe('Q!');
    expect(texts(mod('shift'), mod('shift'), mod('shift'), q)).toBe('q');
  });

  it('Caps affects letters only, and Shift reverses it', () => {
    expect(texts(mod('caps'), q, one)).toBe('Q1');
    expect(texts(mod('caps'), mod('shift'), q)).toBe('q');
  });

  it('named keys Steam types by name go out as keys', () => {
    expect(run(named('Backspace'), named('ArrowLeft')).effects).toEqual([
      { kind: 'key', key: 'Backspace' },
      { kind: 'key', key: 'ArrowLeft' },
    ]);
  });

  it('keys Steam cannot type by name (Esc, Del) go out as chords', () => {
    expect(run(named('Escape')).effects).toEqual([
      {
        kind: 'chord',
        events: [
          [NAMED_CODES.Escape, true],
          [NAMED_CODES.Escape, false],
        ],
      },
    ]);
  });
});

describe('Fn layer', () => {
  it('turns the number row into F-keys and ` into Esc, once', () => {
    const { effects, mods } = run(mod('fn'), one, one);
    expect(effects[0]).toEqual({
      kind: 'chord',
      events: [
        [NAMED_CODES.F1, true],
        [NAMED_CODES.F1, false],
      ],
    });
    expect(effects[1]).toEqual({ kind: 'text', text: '1' });
    expect(mods.fn).toBe('off');
    expect(run(mod('fn'), backquote).effects[0]).toEqual({
      kind: 'chord',
      events: [
        [41, true],
        [41, false],
      ],
    });
  });

  it('labels follow the layer', () => {
    const fnOn: Mods = { ...NO_MODS, fn: 'once' };
    expect(keyLabel(one, fnOn)).toBe('F1');
    expect(keyLabel(backquote, fnOn)).toBe('Esc');
    expect(keyLabel(one, { ...NO_MODS, shift: 'once' })).toBe('!');
  });
});

describe('chords', () => {
  it('Ctrl+C presses Ctrl, C, and releases in reverse', () => {
    expect(run(mod('ctrl'), { type: 'char', char: 'c' }).effects).toEqual([
      {
        kind: 'chord',
        events: [
          [MODIFIER.ctrl, true],
          [6, true],
          [6, false],
          [MODIFIER.ctrl, false],
        ],
      },
    ]);
  });

  it('Shift+Arrow selects (a chord), Ctrl+Shift+Left adds both', () => {
    expect(run(mod('shift'), named('ArrowLeft')).effects[0]).toEqual({
      kind: 'chord',
      events: [
        [MODIFIER.shift, true],
        [80, true],
        [80, false],
        [MODIFIER.shift, false],
      ],
    });
    const both = run(mod('ctrl'), mod('shift'), named('ArrowLeft')).effects[0];
    expect(both).toEqual({
      kind: 'chord',
      events: [
        [MODIFIER.ctrl, true],
        [MODIFIER.shift, true],
        [80, true],
        [80, false],
        [MODIFIER.shift, false],
        [MODIFIER.ctrl, false],
      ],
    });
  });

  it('a shifted symbol under Ctrl includes Shift', () => {
    const effect = run(mod('ctrl'), { type: 'char', char: '!' }).effects[0];
    expect(effect).toEqual({
      kind: 'chord',
      events: [
        [MODIFIER.ctrl, true],
        [MODIFIER.shift, true],
        [30, true],
        [30, false],
        [MODIFIER.shift, false],
        [MODIFIER.ctrl, false],
      ],
    });
  });

  it('Super and Alt chord too, and one-shot modifiers clear after the key', () => {
    const { effects, mods } = run(mod('super'), mod('alt'), q);
    expect(effects[0]).toEqual({
      kind: 'chord',
      events: [
        [MODIFIER.alt, true],
        [MODIFIER.super, true],
        [20, true],
        [20, false],
        [MODIFIER.super, false],
        [MODIFIER.alt, false],
      ],
    });
    expect(mods).toEqual(NO_MODS);
  });

  it('Frame never locks: a second tap sends Super on its own', () => {
    const { effects, mods } = run(mod('super'), mod('super'));
    expect(effects).toEqual([
      {
        kind: 'chord',
        events: [
          [MODIFIER.super, true],
          [MODIFIER.super, false],
        ],
      },
    ]);
    expect(mods).toEqual(NO_MODS);
  });

  it('the context-menu key is Shift+F10', () => {
    expect(run({ type: 'action', action: 'menu' }).effects).toEqual([{ kind: 'chord', events: CLIPBOARD_CHORDS.menu }]);
    expect(CLIPBOARD_CHORDS.menu).toEqual([
      [MODIFIER.shift, true],
      [NAMED_CODES.F10, true],
      [NAMED_CODES.F10, false],
      [MODIFIER.shift, false],
    ]);
  });

  it('a character with no US key under Ctrl does nothing', () => {
    expect(run(mod('ctrl'), { type: 'char', char: 'é' }).effects).toEqual([]);
  });
});

describe('actions', () => {
  it('copy, cut and paste are CUA chords; others are actions', () => {
    expect(run({ type: 'action', action: 'copy' }).effects).toEqual([{ kind: 'chord', events: CLIPBOARD_CHORDS.copy }]);
    expect(run({ type: 'action', action: 'paste' }).effects).toEqual([
      { kind: 'chord', events: CLIPBOARD_CHORDS.paste },
    ]);
    expect(run({ type: 'action', action: 'hide' }).effects).toEqual([{ kind: 'action', action: 'hide' }]);
  });

  it('modifier state shows on and locked', () => {
    expect(modState(run(mod('ctrl')).mods, 'ctrl')).toEqual({ on: true, locked: false });
    expect(modState(run(mod('ctrl'), mod('ctrl')).mods, 'ctrl')).toEqual({ on: true, locked: true });
    expect(modState(run(mod('caps')).mods, 'caps')).toEqual({ on: true, locked: true });
  });
});

describe('keyForChar', () => {
  it('maps letters, digits and symbols to US keys', () => {
    expect(keyForChar('a')).toEqual({ code: 4, shift: false });
    expect(keyForChar('Z')).toEqual({ code: 29, shift: true });
    expect(keyForChar('0')).toEqual({ code: 39, shift: false });
    expect(keyForChar('?')).toEqual({ code: 56, shift: true });
    expect(keyForChar('あ')).toBeNull();
  });
});

describe('alternates', () => {
  const e: KeyDef = { type: 'char', char: 'e', long: ['é', 'è'] };
  it("lists the key, its Shift character (not a letter's capital), then its variants, in the current case", () => {
    expect(alternates(e, NO_MODS)).toEqual(['e', 'é', 'è']);
    expect(alternates(e, { ...NO_MODS, shift: 'once' })).toEqual(['E', 'É', 'È']);
    expect(alternates({ type: 'char', char: 'q' }, NO_MODS)).toEqual(['q']);
    expect(alternates(one, NO_MODS)).toEqual(['1', '!']);
    expect(alternates({ type: 'char', char: ' ' }, NO_MODS)).toEqual([' ']);
    expect(alternates(named('Backspace'), NO_MODS)).toEqual([]);
  });

  it('typing an alternate is text and uses up one-shot Shift', () => {
    expect(pressText({ ...NO_MODS, shift: 'once' }, 'É')).toEqual({
      mods: NO_MODS,
      effects: [{ kind: 'text', text: 'É' }],
    });
  });
});
