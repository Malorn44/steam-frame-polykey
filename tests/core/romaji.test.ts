import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { KeyDef } from '../../src/core/catalog.js';
import { NO_IME, pressIme, reading, settleRomaji, type Ime } from '../../src/core/ime.js';
import { feedRomaji, romajiTable, type TableEntry } from '../../src/core/romaji.js';

const table = romajiTable(
  (JSON.parse(readFileSync('packs/ja/romaji-table.json', 'utf8')) as { entries: TableEntry[] }).entries,
);
const feed = (s: string) => feedRomaji(s, table);

describe('romaji', () => {
  it('turns complete entries into kana and keeps letters that may still grow', () => {
    expect(feed('ka')).toEqual({ out: 'か', rest: '' });
    expect(feed('k')).toEqual({ out: '', rest: 'k' });
    expect(feed('kk')).toEqual({ out: 'っ', rest: 'k' });
    expect(feed('kyo')).toEqual({ out: 'きょ', rest: '' });
    expect(feed('n')).toEqual({ out: '', rest: 'n' }); // could be な…
    expect(feed('nk')).toEqual({ out: 'ん', rest: 'k' }); // …but k cannot follow n
    expect(feed('nn')).toEqual({ out: 'ん', rest: '' });
    expect(feed('-')).toEqual({ out: 'ー', rest: '' });
    expect(feed('K')).toEqual({ out: 'K', rest: '' }); // capitals stay letters
    expect(feedRomaji('n', table, true)).toEqual({ out: 'ん', rest: '' }); // settled before sending
  });
});

const char = (c: string): KeyDef => ({ type: 'char', char: c });
const typeAll = (keys: string, romaji = true): Ime => {
  let ime = NO_IME;
  for (const c of Array.from(keys)) {
    ime = pressIme(
      ime,
      char(c),
      { typed: c },
      { tapCycle: false },
      { modify: new Map(), ...(romaji ? { romaji: table } : {}) },
    )!.ime;
  }
  return ime;
};

describe('typed keys in the buffer', () => {
  it('romaji letters become kana as they complete; what waits is settled before converting', () => {
    expect(reading(typeAll('kanji'))).toBe('かんじ');
    expect(reading(typeAll('kan'))).toBe('かn');
    expect(reading(settleRomaji(typeAll('kan'), table))).toBe('かん');
    expect(reading(typeAll('kitte'))).toBe('きって');
  });

  it('JIS kana: ゛ and ゜ join the kana before them, or stay as typed', () => {
    expect(reading(typeAll('か゛', false))).toBe('が');
    expect(reading(typeAll('は゜', false))).toBe('ぱ');
    expect(reading(typeAll('あ゛', false))).toBe('あ゛');
  });
});
