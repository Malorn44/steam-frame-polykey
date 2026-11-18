import { describe, expect, it } from 'vitest';
import { SWIPE_POINTS, leftKey, recentAfter, resample, spaceBefore, swipeCase, swipeLetter, swipeShifts } from '../../src/core/swipe.js';
import type { KeyboardDef } from '../../src/core/catalog.js';
import { offered, swipeLexicon } from '../../src/core/options.js';

describe('swipe detection', () => {
  const key = { left: 100, top: 50, right: 140, bottom: 80 }; // 40 px wide
  const start = { x: 138, y: 65 }; // near the key's right edge

  it('a press near the edge stays a tap until it is a third of a key outside and half a key away', () => {
    expect(leftKey(start, { x: 150, y: 65 }, key, 40)).toBe(false); // outside, but within the margin
    expect(leftKey(start, { x: 154, y: 65 }, key, 40)).toBe(false); // past the margin (13.3), but only 16 px from the press
    expect(leftKey(start, { x: 159, y: 65 }, key, 40)).toBe(true);
    expect(leftKey(start, { x: 138, y: 40 }, key, 40)).toBe(false); // 10 px above the key: within the margin
    expect(leftKey(start, { x: 138, y: 36 }, key, 40)).toBe(true);
  });

  it('a wobble inside the key is never a swipe', () => {
    expect(leftKey({ x: 101, y: 51 }, { x: 139, y: 79 }, key, 40)).toBe(false);
  });

  it('only letters swipe, and not keys that flick', () => {
    const swipes = (char: string) => swipeLetter({ type: 'char', char });
    expect(['a', 'Z', 'é', 'ß'].map(swipes)).toEqual([true, true, true, true]);
    expect(['1', ' ', ',', 'ab', ''].map(swipes)).toEqual([false, false, false, false, false]);
    expect(swipeLetter({ type: 'char', char: 'a', flick: { left: 'b' } })).toBe(false);
  });
});

describe('resample', () => {
  it('spaces points evenly along the path, keeping both ends', () => {
    const path = resample([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 5);
    expect(path).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 10, y: 10 }]);
  });

  it('gives the same points however densely the laser sampled', () => {
    const sparse = resample([{ x: 0, y: 0 }, { x: 90, y: 0 }], 4);
    const dense = resample(Array.from({ length: 91 }, (_, x) => ({ x, y: 0 })), 4);
    expect(dense.map((p) => Math.round(p.x))).toEqual(sparse.map((p) => p.x));
    expect(resample(Array.from({ length: 300 }, (_, x) => ({ x, y: x }))).length).toBe(SWIPE_POINTS);
  });

  it('rests (repeated points) do not stall it', () => {
    const path = resample([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 4, y: 0 }], 3);
    expect(path).toEqual([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }]);
    expect(resample([{ x: 1, y: 1 }, { x: 1, y: 1 }], 8)).toEqual([{ x: 1, y: 1 }, { x: 1, y: 1 }]);
  });
});

describe('the swiped word', () => {
  it('takes Shift: once a capital, locked or Caps all capitals; otherwise the list\'s case', () => {
    expect(swipeCase('hello', 'once', false)).toBe('Hello');
    expect(swipeCase('hello', 'locked', false)).toBe('HELLO');
    expect(swipeCase('hello', 'off', true)).toBe('HELLO');
    expect(swipeCase('Paris', 'off', false)).toBe('Paris');
  });

  it('gets a space before it after a word or closing punctuation, not at the start or after a space', () => {
    const after = (...texts: string[]) => spaceBefore(recentAfter('', texts.map((text) => ({ kind: 'text', text }))));
    expect(after('hello')).toBe(true);
    expect(after('hello', '.')).toBe(true);
    expect(after('hello', ' ')).toBe(false);
    expect(after('(')).toBe(false);
    expect(spaceBefore('')).toBe(false); // nothing typed before it
    expect(spaceBefore(null)).toBe(false); // unknown: never guess a space
    // On a Japanese keyboard, only after Latin text.
    expect([spaceBefore('hello', true), spaceBefore('3.', true), spaceBefore('日本', true), spaceBefore('です。', true)]).toEqual([true, true, false, false]);
  });

  it('follows Backspace, and forgets on keys that may move the cursor', () => {
    expect(recentAfter('ab ', [{ kind: 'key', key: 'Backspace' }])).toBe('ab');
    expect(recentAfter('a', [{ kind: 'key', key: 'Backspace' }])).toBeNull(); // what is before it is unknown
    expect(recentAfter('ab', [{ kind: 'key', key: 'ArrowLeft' }])).toBeNull();
    expect(recentAfter('ab', [{ kind: 'key', key: 'Enter' }])).toBe('\n');
    expect(recentAfter(null, [{ kind: 'text', text: 'x' }])).toBe('x');
    expect(recentAfter('', [{ kind: 'text', text: 'x'.repeat(100) }])).toBe('x'.repeat(64));
  });
});

describe('swipe on a keyboard', () => {
  const keyboard: KeyboardDef = { id: 'en/x', name: 'X', layout: 'en/qwerty', lexicon: 'en/words', features: { swipe: {} }, options: { swipe: true } };

  it('needs the feature and the option, which the user may turn off', () => {
    expect(swipeLexicon(keyboard, undefined, false)).toBe('en/words');
    expect(swipeLexicon(keyboard, { swipe: false }, false)).toBeUndefined();
    expect(swipeLexicon({ ...keyboard, options: {} }, { swipe: true }, false)).toBeUndefined(); // no option offered
    expect(swipeLexicon({ ...keyboard, features: {} }, undefined, false)).toBeUndefined();
    expect(offered(keyboard)).toContain('swipe');
  });

  it('decodes against the word list of the mode it is in; a mode without one does not swipe', () => {
    const modes: KeyboardDef = { id: 'ja/x', name: 'X', layout: 'ja/qwerty-romaji', composer: 'kana', features: { swipe: {} }, options: { swipe: true },
      modes: [{ id: 'kana' }, { id: 'latin', letters: 'ABC', latin: true, lexicon: 'en/words' }] };
    expect([swipeLexicon(modes, undefined, false), swipeLexicon(modes, undefined, true)]).toEqual([undefined, 'en/words']);
    const korean: KeyboardDef = { ...modes, composer: 'hangul-2set', modes: [{ id: 'hangul', lexicon: 'ko/words' }, modes.modes![1]!] };
    expect([swipeLexicon(korean, undefined, false), swipeLexicon(korean, undefined, true)]).toEqual(['ko/words', 'en/words']);
    // An older pack's list here is not read: the keyboard's own is.
    expect(swipeLexicon({ ...keyboard, features: { swipe: { lexicon: 'mine/words' } } }, undefined, false)).toBe('en/words');
  });

  it('a letter typed with Shift swipes through its key; the Latin letters, whose Shift is their capital, name none', () => {
    expect(swipeShifts([{ type: 'char', char: 'ㅂ', shift: 'ㅃ' }, { type: 'char', char: 'ㅛ' }, { type: 'char', char: '[', shift: '{' },
      { type: 'char', char: 'ㅐ', shift: 'ㅒ' }, { type: 'key', key: 'Tab' }])).toEqual({ 'ㅃ': 'ㅂ', 'ㅒ': 'ㅐ' });
    expect(swipeShifts([{ type: 'char', char: 'q' }, { type: 'char', char: '1', shift: '!' }])).toBeUndefined();
  });
});
