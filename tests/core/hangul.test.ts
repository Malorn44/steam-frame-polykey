import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { KeyDef, TableDef } from '../../src/core/catalog.js';
import type { NamedKey } from '../../src/core/keycodes.js';
import type { ComposerContext } from '../../src/core/composers/composer.js';
import { FINALS, INITIALS, MEDIALS, NO_HANGUL, hangul2Set, hangulTable, syllableText, type Hangul } from '../../src/core/composers/hangul.js';
import { optionsFor } from '../../src/core/options.js';

const def = JSON.parse(readFileSync('packs/ko/hangul.json', 'utf8')) as TableDef;
const ctx: ComposerContext = { options: optionsFor(undefined, undefined), table: def, layout: undefined };
const BACKSPACE: KeyDef = { type: 'key', key: 'Backspace' };

/**
 * Press keys in turn, each a jamo (or any character a key types) or one of `named`, ⌫ for Backspace: what
 * was sent, what the bar shows, and the state left (its syllable). A press not for the composer is written <like this>.
 */
const type = (keys: string, from: Hangul = NO_HANGUL, c = ctx, named: Readonly<Record<string, KeyDef>> = {}) => {
  let s = from;
  let sent = '';
  for (const ch of Array.from(keys)) {
    const key = ch === '⌫' ? BACKSPACE : named[ch] ?? { type: 'char', char: ch };
    const result = hangul2Set.press(s, key, key.type === 'char' ? { typed: key.char } : {}, c);
    if (!result) {
      sent += `<${ch}>`;
      continue;
    }
    s = result.state;
    for (const effect of result.effects) if (effect.kind === 'text') sent += effect.text;
  }
  const shown = hangul2Set.show(s, c).preedit;
  return { sent, bar: 'before' in shown ? shown.before : '', syllable: s };
};
/** Everything typed, the last syllable flushed (as the bar does on Space or a keyboard switch). */
const written = (keys: string, c = ctx): string => {
  const { sent, syllable } = type(keys, NO_HANGUL, c);
  return sent + hangul2Set.flush(syllable, c).effects.map((e) => (e.kind === 'text' ? e.text : '')).join('');
};

describe('the hangul-2set composer', () => {
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
    expect(hangul2Set.press(type('ㅎㅏㄴ').syllable, { type: 'key', key: 'Enter' }, {}, ctx)).toBeNull();
    expect(hangul2Set.flush(type('ㅎㅏㄴ').syllable, ctx).effects).toEqual([{ kind: 'text', text: '한' }]);
    expect(hangul2Set.flush(NO_HANGUL, ctx).effects).toEqual([]);
    expect(hangul2Set.composing(NO_HANGUL)).toBe(false);
  });

  it('makes every syllable with Unicode\'s formula, as the conjoining jamo compose', () => {
    const table = hangulTable(def.hangul!);
    const finals = ['', ...Array.from(FINALS)];
    let count = 0;
    Array.from(INITIALS).forEach((initial, l) => Array.from(MEDIALS).forEach((medial, v) => finals.forEach((final, t) => {
      const conjoining = String.fromCodePoint(0x1100 + l, 0x1161 + v, ...(t ? [0x11a7 + t] : [])).normalize('NFC');
      expect(syllableText(table, { initial, medial: [medial], final: final ? [final] : [] })).toBe(conjoining);
      count++;
    })));
    expect(count).toBe(11_172);
  });

  it('a table\'s pairs are checked against the same jamo: the schema\'s patterns take exactly its vowels and finals', () => {
    const schema = JSON.parse(readFileSync('packs/pack.schema.json', 'utf8')) as {
      $defs: { table: { properties: { hangul: { properties: Record<string, { items: { pattern: string } }> } } } };
    };
    const pattern = (field: string) => new RegExp(schema.$defs.table.properties.hangul.properties[field]!.items.pattern);
    const jamo = Array.from({ length: 0x3163 - 0x3131 + 1 }, (_, i) => String.fromCodePoint(0x3131 + i)); // ㄱ to ㅣ
    expect(jamo.filter((ch) => pattern('compoundMedials').test(ch.repeat(3))).join('')).toBe(MEDIALS);
    expect(jamo.filter((ch) => pattern('compoundFinals').test(ch.repeat(3))).join('')).toBe(FINALS);
  });

  it('its words are Hangul: every syllable, and the jamo it types; not a Hanja, a Latin letter or an old jamo', () => {
    const isWord = hangul2Set.wordChar!;
    const syllables = Array.from({ length: 11_172 }, (_, i) => String.fromCodePoint(0xac00 + i));
    expect([...syllables, ...INITIALS, ...MEDIALS, ...FINALS].every(isWord)).toBe(true);
    expect(['韓', 'a', 'ㅥ', 'ㆎ', '\uabff', '\ud7a4', ' ', '1'].some(isWord)).toBe(false);
  });

  it('without its table the keys type as they are', () => {
    const bare = { ...ctx, table: undefined };
    expect(hangul2Set.press(NO_HANGUL, { type: 'char', char: 'ㄱ' }, { typed: 'ㄱ' }, bare)).toBeNull();
  });
});

describe('천지인: the 2-set composer, with strokes and tap cycles', () => {
  const ctxC: ComposerContext = { ...ctx, table: JSON.parse(readFileSync('packs/ko/hangul-cheonjiin.json', 'utf8')) as TableDef };
  const keys: Record<string, KeyDef> = {
    ㄷ: { type: 'char', char: 'ㄷ', cycle: ['ㄷ', 'ㄸ'] }, '.': { type: 'char', char: '.', cycle: ['.', ','] }, '→': { type: 'key', key: 'ArrowRight' },
  };
  const tap = (taps: string) => type(taps, NO_HANGUL, ctxC, keys);

  it('makes every vowel of the strokes ㅣ ㆍ ㅡ, each joining the vowel before it', () => {
    const strokes: Record<string, string> = {
      ㅣ: 'ㅣ', ㅡ: 'ㅡ', ㅏ: 'ㅣㆍ', ㅓ: 'ㆍㅣ', ㅗ: 'ㆍㅡ', ㅜ: 'ㅡㆍ', ㅢ: 'ㅡㅣ', ㅑ: 'ㅣㆍㆍ', ㅕ: 'ㆍㆍㅣ', ㅛ: 'ㆍㆍㅡ', ㅠ: 'ㅡㆍㆍ',
      ㅐ: 'ㅣㆍㅣ', ㅔ: 'ㆍㅣㅣ', ㅚ: 'ㆍㅡㅣ', ㅟ: 'ㅡㆍㅣ', ㅒ: 'ㅣㆍㆍㅣ', ㅖ: 'ㆍㆍㅣㅣ', ㅘ: 'ㆍㅡㅣㆍ', ㅝ: 'ㅡㆍㆍㅣ', ㅙ: 'ㆍㅡㅣㆍㅣ', ㅞ: 'ㅡㆍㆍㅣㅣ',
    };
    expect(Object.keys(strokes).sort().join('')).toBe(Array.from(MEDIALS).sort().join(''));
    for (const [vowel, made] of Object.entries(strokes)) expect(written(`ㅇ${made}`, ctxC), vowel).toBe(written(`ㅇ${vowel}`));
    expect([tap('ㄱㆍ').bar, tap('ㄱㆍㆍ').bar]).toEqual(['ㄱㆍ', 'ㄱᆢ']); // a stroke is shown as it is until it makes a vowel
  });

  it('a key tapped again types its cycle\'s next character; what a tap sent is held until the cycle ends; → ends it', () => {
    expect(['ㄷ', 'ㄷㄷ', 'ㄷㄷㄷ'].map((taps) => tap(taps).bar)).toEqual(['ㄷ', 'ㄸ', 'ㄷ']);
    expect(tap('ㄱㅣㆍㄷㄷ')).toMatchObject({ sent: '', bar: '가ㄸ' }); // ㄸ ends no syllable: 가 is sent, but held
    expect(tap('ㄱㅣㆍㄷㄷㄷ')).toMatchObject({ sent: '', bar: '갇' }); // and taken back
    expect(tap('ㄱㅣㆍㄷㄷㅣㆍ')).toMatchObject({ sent: '가', bar: '따' });
    expect(tap('ㄷ→ㄷㅣㆍ')).toMatchObject({ sent: 'ㄷ', bar: '다' });
    expect(tap('→').sent).toBe('<→>'); // with no tap to end, → is the field's
    expect(tap('ㄱㅣㆍ..')).toMatchObject({ sent: '', bar: '가,' }); // a cycle of punctuation sends the syllable first
    expect(tap('ㄱㅣㆍ..ㄷ')).toMatchObject({ sent: '가,', bar: 'ㄷ' });
  });

  it('⌫ takes the last stroke off, and the last tap back', () => {
    expect(['', '⌫', '⌫⌫', '⌫⌫⌫', '⌫⌫⌫⌫', '⌫⌫⌫⌫⌫'].map((back) => tap(`ㄱㆍㅡㅣㆍ${back}`).bar)).toEqual(['과', '괴', '고', 'ㄱㆍ', 'ㄱ', '']);
    expect([tap('ㄱㅣㆍㄷ⌫'), tap('ㄱㅣㆍㄷㄷ⌫')]).toMatchObject([{ sent: '', bar: '가' }, { sent: '', bar: '가' }]);
  });

  it('한자 ends an open tap first: what it held is sent, and is part of the word converted', () => {
    const typed = tap('ㅎㅣㆍㄴㄷ'); // the tap sent 한: held while it may still become ㄸ
    expect([typed.sent, typed.bar]).toEqual(['', '한ㄷ']);
    const asked = hangul2Set.press(typed.syllable, { type: 'action', action: 'convert' }, {}, { ...ctxC, before: '' })!;
    expect([asked.effects, hangul2Set.convert!.reading(asked.state, ctxC)]).toEqual([[{ kind: 'text', text: '한' }], '한ㄷ']);
  });
});

describe('한자: converting the word before the caret', () => {
  const CONVERT: KeyDef = { type: 'action', action: 'convert' };
  const SPACE: KeyDef = { type: 'char', char: ' ' };
  const key = (name: NamedKey): KeyDef => ({ type: 'key', key: name });
  /** Jamo typed with `before` the word typed before them (as the bar gives it), then 한자. */
  const convertAfter = (before: string, keys: string) => {
    const { syllable: typed } = type(keys);
    return hangul2Set.press(typed, CONVERT, {}, { ...ctx, before })!;
  };
  /** The converter's answer: what goes before the word, then the word with these Hanja. */
  const answer = (state: Hangul, word: string, candidates: string[], notes?: string[]) => {
    const reading = hangul2Set.convert!.reading(state, ctx);
    const segments = [...(reading.length > word.length ? [{ reading: reading.slice(0, -word.length), candidates: [] }] : []),
      { reading: word, candidates, ...(notes ? { notes } : {}) }];
    return hangul2Set.convert!.converted(state, reading, segments);
  };
  const backspaces = (effects: readonly { kind: string }[]) => effects.filter((e) => e.kind === 'key').length;
  const texts = (effects: readonly { kind: string; text?: string }[]) => effects.flatMap((e) => (e.kind === 'text' ? [e.text] : []));

  it('asks about the word\'s Hangul typed before the syllable, then the syllable', () => {
    const asked = convertAfter('오늘한', 'ㄱㅜㄱ');
    expect(asked.request).toEqual({ kind: 'convert' });
    expect(asked.effects).toEqual([]);
    expect(hangul2Set.convert!.reading(asked.state, ctx)).toBe('오늘한국');
    expect(hangul2Set.composing(asked.state)).toBe(true); // asked for: sending what waits ends it
    expect(hangul2Set.show(asked.state, ctx).preedit).toEqual({ before: '국', after: '' }); // the text as it is until the answer
    // Only the word's Hangul at the end: not a converted word or a Latin letter before it.
    expect(hangul2Set.convert!.reading(convertAfter('abc韓國어', 'ㄷㅗ').state, ctx)).toBe('어도');
    expect(hangul2Set.convert!.reading(convertAfter('한국', '').state, ctx)).toBe('한국'); // nothing composed
    expect(hangul2Set.convert!.reading(convertAfter('', 'ㅎㅏㄴ').state, ctx)).toBe('한');
    expect(hangul2Set.convert!.reading(convertAfter('가'.repeat(80), 'ㄴㅏ').state, ctx)).toBe(`${'가'.repeat(63)}나`); // MAX_READING
  });

  it('with nothing to convert, 한자 does nothing', () => {
    const none = convertAfter('', '');
    expect([none.effects, none.request, hangul2Set.composing(none.state)]).toEqual([[], undefined, false]);
    expect(convertAfter('abc', '').request).toBeUndefined();
  });

  it('shows the word\'s candidates and meanings while the text stays as it is; Space (next) goes on, and wraps', () => {
    const shown = answer(convertAfter('오늘한', 'ㄱㅜㄱ').state, '한국', ['寒國', '韓國'], ['', '대한민국']);
    expect(hangul2Set.show(shown, ctx)).toEqual({
      preedit: { segments: ['오늘', '寒國'], focus: 1, candidates: ['寒國', '韓國'], selected: 0, notes: ['', '대한민국'] }, // the word as picked
      labels: { ' ': 'next' }, active: ['convert'], // Space says next, 한자 shows the mode's mark
    });
    const next = hangul2Set.press(shown, SPACE, { typed: ' ' }, ctx)!;
    expect(next.effects).toEqual([]);
    expect(hangul2Set.show(next.state, ctx).preedit).toMatchObject({ segments: ['오늘', '韓國'], focus: 1, selected: 1 });
    const wrapped = hangul2Set.press(next.state, SPACE, { typed: ' ' }, ctx)!;
    expect(wrapped.effects).toEqual([]);
    expect(hangul2Set.show(wrapped.state, ctx).preedit).toMatchObject({ selected: 0 });
    // Asked for, not answered yet: as before, nothing marked.
    expect(hangul2Set.show(convertAfter('', 'ㄱㅜㄱ').state, ctx)).toEqual({ preedit: { before: '국', after: '' }, labels: {} });
    expect('notes' in hangul2Set.show(answer(convertAfter('', 'ㄱㅜㄱ').state, '국', ['國']), ctx).preedit).toBe(false);
  });

  it('a pick deletes the word\'s syllables typed before the composition, drops the composition, then types the Hanja', () => {
    const shown = answer(convertAfter('오늘한', 'ㄱㅜㄱ').state, '한국', ['寒國', '韓國']);
    const picked = hangul2Set.convert!.pick(shown, '韓國', 1, null);
    expect(picked.effects).toEqual([{ kind: 'key', key: 'Backspace' }, { kind: 'text', text: '韓國' }]); // 한; 국 was the composition
    expect(picked.state).toEqual(NO_HANGUL);
    expect(picked.learned).toEqual({ reading: '한국', lengths: [2], choices: [1], texts: ['韓國'] });
    // Enter picks the one selected.
    const entered = hangul2Set.press(hangul2Set.press(shown, SPACE, { typed: ' ' }, ctx)!.state, key('Enter'), {}, ctx)!;
    expect(texts(entered.effects)).toEqual(['韓國']);
    // Only the composition: no Backspace. Nothing composed: one for each syllable.
    expect(hangul2Set.convert!.pick(answer(convertAfter('한', 'ㄱㅜㄱ').state, '국', ['國']), '國', 0, null).effects)
      .toEqual([{ kind: 'text', text: '國' }]);
    const sent = hangul2Set.convert!.pick(answer(convertAfter('대한국', '').state, '한국', ['韓國']), '韓國', 0, null).effects;
    expect([backspaces(sent), texts(sent)]).toEqual([2, ['韓國']]);
    // Not one of the shown candidates: nothing.
    expect(hangul2Set.convert!.pick(shown, '韓國', 0, null)).toEqual({ state: shown, effects: [] });
    expect(hangul2Set.convert!.pick(convertAfter('', 'ㄱㅜㄱ').state, '國', 0, null).effects).toEqual([]); // not answered yet
  });

  /** The converter's answer as segments: a word with Hanja written [like this], with its candidates. */
  const cut = (state: Hangul, marked: string, candidates: string[]) => {
    const reading = hangul2Set.convert!.reading(state, ctx);
    const segments = marked.split(/[[\]]/u).map((part, i) => ({ reading: part, candidates: i === 1 ? candidates : [] })).filter((s) => s.reading);
    return hangul2Set.convert!.converted(state, reading, segments);
  };

  it('a word inside the reading: the pick deletes back to its start and types the Hanja, then what followed it; the syllable stays', () => {
    const shown = cut(convertAfter('학교에', 'ㅅㅓ').state, '[학교]에서', ['學校', '學敎']);
    expect(hangul2Set.show(shown, ctx).preedit).toEqual({ segments: ['學校', '에서'], focus: 0, candidates: ['學校', '學敎'], selected: 0 });
    const picked = hangul2Set.convert!.pick(shown, '學校', 0, null);
    // 학교에 were typed before the composition (서): three Backspaces, then 學校 and 에. 서 is still being composed.
    expect([backspaces(picked.effects), texts(picked.effects)]).toEqual([3, ['學校에']]);
    expect([hangul2Set.show(picked.state, ctx).preedit, picked.learned]).toEqual([
      { before: '서', after: '' }, { reading: '학교', lengths: [2], choices: [0], texts: ['學校'] }]);
    // In the middle, with nothing composed.
    const middle = cut(convertAfter('오늘한국어', '').state, '오늘[한국]어', ['韓國']);
    const sent = hangul2Set.convert!.pick(middle, '韓國', 0, null);
    expect([backspaces(sent.effects), texts(sent.effects), hangul2Set.composing(sent.state)]).toEqual([3, ['韓國어'], false]);
  });

  it('← and → ask for the word with Hanja before or after this one, and the answer moves the focus to it', () => {
    const shown = cut(convertAfter('학교에', 'ㅅㅓ').state, '[학교]에서', ['學校']);
    expect(hangul2Set.press(shown, key('ArrowRight'), {}, ctx)).toEqual({
      state: shown, effects: [], request: { kind: 'convert', lengths: [2, 2], resize: [0, 1] },
    });
    const next = cut(shown, '학교에[서]', ['西']);
    expect(hangul2Set.show(next, ctx).preedit).toMatchObject({ segments: ['학교에', '西'], focus: 1, candidates: ['西'], selected: 0 });
    expect(hangul2Set.press(next, key('ArrowLeft'), {}, ctx)!.request).toEqual({ kind: 'convert', lengths: [3, 1], resize: [1, -1] });
    // The last syllable is the composition: picking it drops it, with no Backspace.
    const picked = hangul2Set.convert!.pick(next, '西', 0, null);
    expect([picked.effects, picked.state]).toEqual([[{ kind: 'text', text: '西' }], NO_HANGUL]);
  });

  it('한자 again or ⌫ closes it with the text as it was; typing ends it, then acts; nothing sends a Hanja that was not picked', () => {
    const shown = answer(convertAfter('한', 'ㄱㅜㄱ').state, '한국', ['韓國', '寒國']);
    const stepped = hangul2Set.press(shown, SPACE, { typed: ' ' }, ctx)!.state; // a candidate further on: still nothing sent
    for (const close of [CONVERT, BACKSPACE]) {
      const ended = hangul2Set.press(stepped, close, {}, ctx)!;
      expect([ended.effects, ended.request, hangul2Set.show(ended.state, ctx)]).toEqual([[], undefined, { preedit: { before: '국', after: '' }, labels: {} }]);
    }
    const typedOn = hangul2Set.press(shown, { type: 'char', char: 'ㅇ' }, { typed: 'ㅇ' }, ctx)!;
    expect([typedOn.effects, hangul2Set.show(typedOn.state, ctx).preedit]).toEqual([[{ kind: 'text', text: '국' }], { before: 'ㅇ', after: '' }]);
    expect(hangul2Set.press(shown, { type: 'char', char: '.' }, { typed: '.' }, ctx)).toBeNull(); // the bar sends what waits, then acts
    expect(hangul2Set.press(shown, key('Tab'), {}, ctx)).toBeNull();
    expect(hangul2Set.flush(shown, ctx)).toEqual({ state: NO_HANGUL, effects: [{ kind: 'text', text: '국' }] }); // the syllable, never 韓國
    expect(hangul2Set.flush(answer(convertAfter('한국', '').state, '한국', ['韓國']), ctx).effects).toEqual([]);
    expect(hangul2Set.show(hangul2Set.convert!.cancel!(shown), ctx).preedit).toEqual({ before: '국', after: '' });
  });

  it('an answer for a reading it moved on from, or with nothing to convert to, changes nothing; the text stays', () => {
    const asked = convertAfter('한', 'ㄱㅜㄱ').state;
    expect(hangul2Set.convert!.converted(asked, '국', [{ reading: '국', candidates: ['國'] }])).toBe(asked);
    const typedOn = hangul2Set.press(asked, { type: 'char', char: 'ㅇ' }, { typed: 'ㅇ' }, ctx)!.state; // typing on ends what was asked
    expect(hangul2Set.convert!.converted(typedOn, '한국', [{ reading: '한국', candidates: ['韓國'] }])).toBe(typedOn);
    const nothing = hangul2Set.convert!.converted(asked, '한국', []);
    expect([hangul2Set.composing(nothing), hangul2Set.show(nothing, ctx).preedit]).toEqual([true, { before: '국', after: '' }]);
    expect(nothing.conversion).toBeNull();
    // A resize with nothing new keeps what is shown.
    const shown = answer(asked, '한국', ['韓國']);
    expect(hangul2Set.convert!.converted(shown, '한국', [])).toBe(shown);
  });
});
