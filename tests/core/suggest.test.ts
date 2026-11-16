import { describe, expect, it } from 'vitest';
import type { Effect } from '../../src/core/keyboard.js';
import { NO_WORD, UNKNOWN, closeUp, matchCase, rank, replaceText, replaceWord, slotOrder, suggestPrefix, trackWord } from '../../src/core/suggest.js';

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
    expect(suggestPrefix({ word: '학', known: true }, '교')).toBe('학교'); // sent, then what is composed
    expect(suggestPrefix(NO_WORD, '하')).toBe('하');
    expect(suggestPrefix(NO_WORD, '')).toBeNull();
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

  it('keeps what the typed letters and the suggestion start with, deletes the rest of them, then adds a space', () => {
    expect(replaceWord('Hel', 'hello')).toEqual([text('lo ')]);
    expect(replaceWord('teh', 'the')).toEqual([key('Backspace'), key('Backspace'), text('he ')]);
    expect(replaceWord('café', 'cafés')).toEqual([text('s ')]); // é is one character
    expect(replaceWord('cafe', 'café')).toEqual([key('Backspace'), text('é ')]);
    expect(replaceWord('the', 'the')).toEqual([text(' ')]);
    expect(replaceText('하', '한국 ')).toEqual([key('Backspace'), text('한국 ')]); // a syllable is one character
  });

  it('a pick in a field that completes inline (an address bar) leaves no letter of the typed word behind', () => {
    // The field: typed letters, and the completion it selects after them, as a browser's address bar
    // does. A Backspace with a selection deletes only the selection; typing replaces it.
    const field = (effects: Effect[]) => effects.reduce(({ value, selected }, effect) => {
      if (effect.kind === 'key') return selected ? { value, selected: '' } : { value: value.slice(0, -1), selected: '' };
      if (effect.kind !== 'text') return { value, selected };
      const typed = value + effect.text;
      const site = ['telegram.org', 'television.example'].find((s) => s.startsWith(typed) && s !== typed);
      return { value: typed, selected: site ? site.slice(typed.length) : '' };
    }, { value: '', selected: '' });
    expect(field([text('t'), text('e')])).toEqual({ value: 'te', selected: 'legram.org' });
    const deletingAll: Effect[] = [key('Backspace'), key('Backspace'), text('television ')];
    expect(field([text('t'), text('e'), ...deletingAll]).value).toBe('ttelevision '); // as reported: the selection took a Backspace
    expect(field([text('t'), text('e'), ...replaceWord('te', 'television')])).toEqual({ value: 'television ', selected: '' });
  });

  it('closeUp: one punctuation mark deletes the space before it; anything else is left alone', () => {
    for (const mark of '.,!?;:') expect(closeUp([text(mark)])).toEqual([key('Backspace'), text(mark)]);
    for (const effects of [[text('a')], [text(' ')], [text('('), text(')')], [key('Enter')], []]) expect(closeUp(effects)).toBe(effects);
  });
});
