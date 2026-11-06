import { describe, expect, it } from 'vitest';
import type { Effect } from '../../src/core/keyboard.js';
import {
  NO_WORD,
  UNKNOWN,
  matchCase,
  rank,
  replaceWord,
  slotOrder,
  suggestPrefix,
  trackWord,
} from '../../src/core/suggest.js';

const text = (t: string): Effect => ({ kind: 'text', text: t });
const key = (k: 'Backspace' | 'Enter' | 'ArrowLeft'): Effect => ({ kind: 'key', key: k });
const track = (...effects: Effect[]) => trackWord(NO_WORD, effects);

describe('trackWord', () => {
  it('collects letters and ends the word at a space or punctuation', () => {
    expect(track(text('h'), text('e'), text('l')).state).toEqual({ word: 'hel', known: true });
    expect(track(text('h'), text('i'), text(' '))).toEqual({ state: NO_WORD, ended: 'hi' });
    expect(track(text('o'), text('k'), text(',')).ended).toBe('ok');
    expect(track(text("don't")).state.word).toBe("don't");
  });

  it('Backspace edits the word, and past it the text is unknown', () => {
    expect(track(text('he'), key('Backspace')).state).toEqual({ word: 'h', known: true });
    expect(track(text('h'), key('Backspace'), key('Backspace')).state).toEqual(UNKNOWN);
  });

  it('arrows and chords make the word unknown; Enter is a boundary', () => {
    expect(track(text('he'), key('ArrowLeft')).state).toEqual(UNKNOWN);
    expect(track(text('he'), { kind: 'chord', events: [] }).state).toEqual(UNKNOWN);
    expect(track(text('he'), key('Enter'))).toEqual({ state: NO_WORD, ended: 'he' });
    expect(trackWord(UNKNOWN, [text('x'), text(' ')]).ended).toBeUndefined(); // part of an unknown word
  });

  it('suggests for the letters typed, even after the text before became unknown', () => {
    expect(suggestPrefix({ word: 'he', known: true })).toBe('he');
    expect(suggestPrefix({ word: 'he', known: false })).toBe('he'); // typed after a Backspace past the word
    expect(suggestPrefix(UNKNOWN)).toBeNull();
    expect(suggestPrefix(NO_WORD)).toBeNull();
  });
});

describe('ranking and replacing', () => {
  it('puts words used this session first, then the list order; best goes in the middle', () => {
    const ranked = rank(['the', 'they', 'there', 'then'], new Map([['then', 2]]));
    expect(ranked).toEqual(['then', 'the', 'they']);
    expect(slotOrder(ranked)).toEqual(['the', 'then', 'they']);
    expect(slotOrder(['only'])).toEqual([undefined, 'only', undefined]);
  });

  it('matches the case it was typed in', () => {
    expect(matchCase('hello', 'He')).toBe('Hello');
    expect(matchCase('hello', 'HE')).toBe('HELLO');
    expect(matchCase('hello', 'h')).toBe('hello');
    expect(matchCase('Helsinki', 'hel')).toBe('Helsinki');
  });

  it('replaces exactly the typed letters, then adds a space', () => {
    expect(replaceWord('Hel', 'hello')).toEqual([key('Backspace'), key('Backspace'), key('Backspace'), text('Hello ')]);
    expect(replaceWord('café', 'cafés').filter((e) => e.kind === 'key')).toHaveLength(4); // é is one character
  });
});
