import { describe, expect, it } from 'vitest';
import type { FlickKey, KeyDef } from '../../src/core/catalog.js';
import { NO_KANA, flickDirection, modifyTable, pressKana, type KanaState } from '../../src/core/kana.js';
import { optionsFor } from '../../src/core/options.js';

const ta: FlickKey = { type: 'flick', flick: ['た', 'ち', 'つ', 'て', 'と'], cycle: ['た', 'ち', 'つ', 'て', 'と', 'っ'] };
const ha: FlickKey = { type: 'flick', flick: ['は', 'ひ', 'ふ', 'へ', 'ほ'] };
const modify = modifyTable(['はばぱ', 'つっづ']);
const action = (a: 'modify' | 'undo'): KeyDef => ({ type: 'action', action: a });
const right: KeyDef = { type: 'key', key: 'ArrowRight' };

/** Press keys in turn; returns the text the app would show (Backspace removes the last character). */
const typeOut = (presses: [KeyDef, string?][], tapCycle: boolean): string => {
  let state: KanaState = NO_KANA;
  let text = '';
  for (const [key, flicked] of presses) {
    const result = pressKana(state, key, flicked, { tapCycle }, modify);
    state = result?.state ?? NO_KANA;
    for (const effect of result?.effects ?? [{ kind: 'key', key: (key as { key: string }).key }]) {
      if (effect.kind === 'text') text += effect.text;
      else if (effect.kind === 'key' && effect.key === 'Backspace') text = Array.from(text).slice(0, -1).join('');
      else if (effect.kind === 'key') text += `<${effect.key}>`;
      else if (effect.kind === 'chord') text += '<undo>';
    }
  }
  return text;
};

describe('flick direction', () => {
  it('is a tap below the threshold, else the nearest axis', () => {
    expect(flickDirection(5, 5)).toBe('tap');
    expect(flickDirection(-40, 8)).toBe('left');
    expect(flickDirection(6, -40)).toBe('up');
    expect(flickDirection(40, -20)).toBe('right');
    expect(flickDirection(0, 30)).toBe('down');
  });
});

describe('12-key', () => {
  it('a flick types its kana', () => {
    expect(typeOut([[ta, 'つ'], [ha, 'ほ']], false)).toBe('つほ');
  });

  it('tapping the same key again types it again (the default)', () => {
    expect(typeOut([[ta], [ta]], false)).toBe('たた');
  });

  it('with tapCycle, tapping again goes through its cycle; → ends it, and is not sent', () => {
    expect(typeOut([[ta], [ta], [ta]], true)).toBe('つ');
    expect(typeOut([[ta], [ta], [right], [ta]], true)).toBe('ちた');
    expect(typeOut([[ta], [ta], [ta], [ta], [ta], [ta], [ta]], true)).toBe('た'); // past っ it wraps
    expect(typeOut([[ta], [ha], [ha]], true)).toBe('たひ'); // another key starts its own cycle
    expect(typeOut([[right]], true)).toBe('<ArrowRight>'); // no cycle open: → moves the cursor
  });

  it('↶ steps back through the cycle, or undoes in the app', () => {
    expect(typeOut([[ta], [ta], [ta], [action('undo')]], true)).toBe('ち');
    expect(typeOut([[ta], [action('undo')]], false)).toBe('た<undo>');
  });

  it('゛゜小 changes the kana just typed, and only that', () => {
    expect(typeOut([[ha], [action('modify')], [action('modify')]], false)).toBe('ぱ');
    expect(typeOut([[ta, 'つ'], [action('modify')]], false)).toBe('っ');
    expect(typeOut([[ha], [right], [action('modify')]], false)).toBe('は<ArrowRight>'); // the cursor moved: nothing to change
  });
});

describe('keyboard options', () => {
  const keyboard = { id: 'ja/12key', name: '12', layout: 'ja/flick', options: { tapCycle: false } };
  it('take the keyboard default, then the user choice, and only options the keyboard has', () => {
    expect(optionsFor(keyboard, undefined).tapCycle).toBe(false);
    expect(optionsFor(keyboard, { tapCycle: true }).tapCycle).toBe(true);
    expect(optionsFor({ ...keyboard, options: {} }, { tapCycle: true }).tapCycle).toBe(false);
  });
});
