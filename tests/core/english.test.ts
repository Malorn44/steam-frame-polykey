import { describe, expect, it } from 'vitest';
import type { KeyDef } from '../../src/core/catalog.js';
import { NO_ENGLISH, englishText, pressEnglish, type EnglishWord } from '../../src/core/english.js';

const char = (c: string): KeyDef => ({ type: 'char', char: c });
const named = (key: 'Backspace' | 'Enter' | 'ArrowLeft' | 'ArrowRight' | 'Tab'): KeyDef => ({ type: 'key', key });

/** Type characters, then press keys: the word left and the text sent. */
const run = (steps: (string | KeyDef)[]): { word: string; caret: number; sent: string } => {
  let word: EnglishWord = NO_ENGLISH;
  let sent = '';
  for (const step of steps) {
    const key = typeof step === 'string' ? char(step) : step;
    const result = pressEnglish(word, key, typeof step === 'string' ? step : undefined);
    if (!result) {
      sent += `<${(key as { key?: string }).key}>`;
      continue;
    }
    word = result.word;
    for (const effect of result.effects) if (effect.kind === 'text') sent += effect.text;
  }
  return { word: englishText(word), caret: word.caret, sent };
};

describe('English word in 英数 mode', () => {
  it('letters and apostrophes wait; anything else sends the word followed by it', () => {
    expect(run(['d', 'o', 'n', "'", 't'])).toEqual({ word: "don't", caret: 5, sent: '' });
    expect(run(['h', 'i', ' '])).toEqual({ word: '', caret: 0, sent: 'hi ' });
    expect(run(['h', 'i', '!', '2'])).toEqual({ word: '', caret: 0, sent: 'hi!2' });
  });

  it('⌫ and ← → edit the word; 確定 sends it alone; with no word they act as usual', () => {
    expect(run(['c', 'a', 't', named('ArrowLeft'), named('Backspace'), 'u'])).toEqual({ word: 'cut', caret: 2, sent: '' });
    expect(run(['h', 'i', named('Enter')]).sent).toBe('hi');
    expect(run([named('Backspace'), named('Enter')]).sent).toBe('<Backspace><Enter>');
    expect(run(['h', 'i', named('Tab')])).toEqual({ word: 'hi', caret: 2, sent: '<Tab>' }); // the caller sends it, then Tab
  });

  it('↶ drops the word', () => {
    expect(run(['h', 'i', { type: 'action', action: 'undo' }])).toEqual({ word: '', caret: 0, sent: '' });
  });
});
