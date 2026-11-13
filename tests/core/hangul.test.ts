import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { KeyDef, TableDef } from '../../src/core/catalog.js';
import type { ComposerContext } from '../../src/core/composers/composer.js';
import { NO_SYLLABLE, hangul, hangulTable, syllableText, type Syllable } from '../../src/core/composers/hangul.js';
import { optionsFor } from '../../src/core/options.js';

const def = JSON.parse(readFileSync('packs/ko/hangul.json', 'utf8')) as TableDef;
const ctx: ComposerContext = { options: optionsFor(undefined, undefined), table: def, layout: undefined };
const BACKSPACE: KeyDef = { type: 'key', key: 'Backspace' };

/**
 * Press keys in turn, each a jamo (or any character a key types), ⌫ for Backspace: what was sent, what the
 * bar shows, and the syllable left. A press not for the composer is written <like this>.
 */
const type = (keys: string, from: Syllable = NO_SYLLABLE) => {
  let s = from;
  let sent = '';
  for (const ch of Array.from(keys)) {
    const result = ch === '⌫' ? hangul.press(s, BACKSPACE, {}, ctx) : hangul.press(s, { type: 'char', char: ch }, { typed: ch }, ctx);
    if (!result) {
      sent += `<${ch}>`;
      continue;
    }
    s = result.state;
    for (const effect of result.effects) if (effect.kind === 'text') sent += effect.text;
  }
  const shown = hangul.show(s, ctx).preedit;
  return { sent, bar: 'before' in shown ? shown.before : '', syllable: s };
};
/** Everything typed, the last syllable flushed (as the bar does on Space or a keyboard switch). */
const written = (keys: string): string => {
  const { sent, syllable } = type(keys);
  return sent + hangul.flush(syllable, ctx).effects.map((e) => (e.kind === 'text' ? e.text : '')).join('');
};

describe('the hangul composer', () => {
  it('composes words, each syllable sent as the next begins', () => {
    expect(written('ㅎㅏㄴㄱㅡㄹ')).toBe('한글');
    expect(written('ㄱㅏㅂㅅ')).toBe('값');
    expect(written('ㄷㅏㄹㄱ')).toBe('닭');
    expect(written('ㅇㅓㅂㅅㅇㅓ')).toBe('없어');
    expect(written('ㄱㅗㅐㄴㅊㅏㄴㅎㅇㅏ')).toBe('괜찮아');
    expect(written('ㅇㅡㅣㅅㅏ')).toBe('의사');
    expect(written('ㅂㅜㅔㄹㄱ')).toBe('뷁');
    expect(type('ㅎㅏㄴㄱ')).toMatchObject({ sent: '한', bar: 'ㄱ' }); // only the syllable being composed is in the bar
  });

  it('a vowel after a final takes that consonant into the new syllable', () => {
    expect(type('ㅎㅏㄴㅏ')).toMatchObject({ sent: '하', bar: '나' });
    expect(type('ㄷㅏㄹㄱㅏ')).toMatchObject({ sent: '달', bar: '가' }); // the second of a compound final
    expect(type('ㅇㅓㅂㅅㅓ')).toMatchObject({ sent: '업', bar: '서' });
  });

  it('pairs vowels and finals that combine, and sends what cannot join', () => {
    expect([written('ㅇㅗㅏ'), written('ㅇㅜㅓ'), written('ㅇㅗㅣ'), written('ㅇㅜㅔ')]).toEqual(['와', '워', '외', '웨']);
    expect([written('ㅇㅏㄴㅈ'), written('ㅇㅏㄹㅎ'), written('ㅇㅡㄹㅍ')]).toEqual(['앉', '앓', '읊']);
    expect(type('ㄱㅏㅣ')).toMatchObject({ sent: '가', bar: 'ㅣ' }); // ㅏ and ㅣ do not combine
    expect(type('ㄱㅏㄴㄱ')).toMatchObject({ sent: '간', bar: 'ㄱ' }); // nor ㄴ and ㄱ
    expect(type('ㄱㅏㄺㅏ')).toMatchObject({ sent: '갉', bar: 'ㅏ' }); // a compound final typed whole is one final, and starts no syllable
    expect(type('ㄺ')).toMatchObject({ sent: 'ㄺ', bar: '' }); // so alone it is sent as it is
  });

  it('jamo alone: a consonant or vowel with nothing to join waits alone, the next one sends it', () => {
    expect(type('ㄱ')).toMatchObject({ sent: '', bar: 'ㄱ' });
    expect(type('ㄱㄴ')).toMatchObject({ sent: 'ㄱ', bar: 'ㄴ' });
    expect(type('ㅏㄴ')).toMatchObject({ sent: 'ㅏ', bar: 'ㄴ' });
    expect(type('ㅗㅏ')).toMatchObject({ sent: '', bar: 'ㅘ' });
  });

  it('Shift\'s tense consonants and ㅒㅖ: ㄲ and ㅆ can end a syllable, ㄸ ㅃ ㅉ only start one', () => {
    expect([written('ㅃㅏ'), written('ㅉㅏ'), written('ㅇㅣㅆ'), written('ㅂㅏㄲ'), written('ㅇㅒ'), written('ㅇㅖ')])
      .toEqual(['빠', '짜', '있', '밖', '얘', '예']);
    expect(type('ㄱㅏㄸ')).toMatchObject({ sent: '가', bar: 'ㄸ' });
    expect(written('ㄱㅏㄸㅏ')).toBe('가따');
  });

  it('⌫ takes the last jamo off, one at a time; with nothing composed it is the field\'s', () => {
    const steps = ['', '⌫', '⌫⌫', '⌫⌫⌫', '⌫⌫⌫⌫'].map((back) => type(`ㄷㅏㄹㄱ${back}`).bar);
    expect(steps).toEqual(['닭', '달', '다', 'ㄷ', '']);
    expect(type('ㄷㅏㄹㄱ⌫⌫⌫⌫⌫').sent).toBe('<⌫>');
    expect(type('ㄱㅗㅐ⌫').bar).toBe('고'); // a compound vowel comes apart
    expect(type('ㄱㅏㅂㅅ⌫').bar).toBe('갑');
  });

  it('Space, Enter, punctuation and digits are not for it: the bar sends the syllable first', () => {
    expect(type('ㅎㅏㄴ .1')).toMatchObject({ sent: '< ><.><1>', bar: '한' });
    expect(hangul.press(type('ㅎㅏㄴ').syllable, { type: 'key', key: 'Enter' }, {}, ctx)).toBeNull();
    expect(hangul.flush(type('ㅎㅏㄴ').syllable, ctx).effects).toEqual([{ kind: 'text', text: '한' }]);
    expect(hangul.flush(NO_SYLLABLE, ctx).effects).toEqual([]);
    expect(hangul.composing(NO_SYLLABLE)).toBe(false);
  });

  it('makes every syllable with Unicode\'s formula, as the conjoining jamo compose', () => {
    const table = hangulTable(def.hangul!);
    const initials = Array.from(def.hangul!.initials);
    const medials = Array.from(def.hangul!.medials);
    const finals = ['', ...Array.from(def.hangul!.finals)];
    let count = 0;
    initials.forEach((initial, l) => medials.forEach((medial, v) => finals.forEach((final, t) => {
      const conjoining = String.fromCodePoint(0x1100 + l, 0x1161 + v, ...(t ? [0x11a7 + t] : [])).normalize('NFC');
      expect(syllableText(table, { initial, medial: [medial], final: final ? [final] : [] })).toBe(conjoining);
      count++;
    })));
    expect(count).toBe(11_172);
  });

  it('without its table the keys type as they are', () => {
    const bare = { ...ctx, table: undefined };
    expect(hangul.press(NO_SYLLABLE, { type: 'char', char: 'ㄱ' }, { typed: 'ㄱ' }, bare)).toBeNull();
  });
});
