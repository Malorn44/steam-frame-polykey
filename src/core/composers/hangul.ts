// The hangul-2set composer: Korean on a 2-set (두벌식) layout, typed jamo by jamo, the syllable being
// composed shown in the bar (or typed into the field, where the bar controller retypes it: `inline`) and
// sent once the next jamo cannot join it. Pure. A 2-set key types the same jamo whether it starts or ends
// a syllable, so where a consonant goes follows from what comes next (the vowel rule below); a 3-set (세벌식) layout types the two apart and would be a composer of its own, with
// the same syllables (syllableText) and Unicode lists. A syllable is Unicode's formula, 0xAC00 + (initial × 21 +
// medial) × 28 + final (The Unicode Standard, 3.12), each its jamo's place in Unicode's lists below, which
// are facts, not layout data. Its table (a table pack's hangul) is what a layout varies: the jamo typed one
// after the other that make one (ㅗㅏ → ㅘ, ㄱㅅ → ㄳ).
//
//   - A jamo that can join the syllable does: 가 + ㄴ → 간, 고 + ㅏ → 과, 갑 + ㅅ → 값.
//   - One that cannot sends the syllable and starts the next: 간 + ㄱ → 간 ㄱ.
//   - A vowel after a final takes that consonant into the new syllable: 한 + ㅏ → 하 나, 닭 + ㅏ → 달 가.
//   - ⌫ takes the last jamo off (닭 → 달 → 다 → ㄷ → nothing); with nothing composed it is the field's.
//   - Anything else (Space, Enter, punctuation, a mode or keyboard switch) is not for it: the bar sends
//     the syllable first, then the key acts as usual.
//
// 한자 (the convert key) converts a word in the one before the caret to Hanja: its Hangul typed before the
// syllable (ctx.before, what polykey typed of it) and the syllable. The keyboard's converter (hanja) picks
// the longest word with Hanja in it (학교 in 학교에서); the text stays as it is while the bar shows the
// candidates, with their meanings, and 한자 shows the mode's mark. 한자 again or Space (labelled next) goes
// on to the next candidate; ← and → go to the word with Hanja before or after it; Enter or a tap picks: a
// Backspace for each syllable from the word's start to the composition, then the Hanja and what followed the
// word (學校에서), the composition still being composed unless it was part of the word. ⌫ ends it, the text
// as it was; anything else ends it, then acts. Nothing but a picked candidate is ever sent as Hanja.

import type { HangulTableDef, KeyDef } from '../catalog.js';
import type { Effect } from '../keyboard.js';
import { MAX_READING, builtOnce, type Composer, type ComposerContext, type ComposerResult, type Converted } from './composer.js';

/** The syllable being composed, jamo as typed: its initial ('' for none), its vowel and its final in one or two parts each. */
export interface Syllable { readonly initial: string; readonly medial: readonly string[]; readonly final: readonly string[] }
export const NO_SYLLABLE: Syllable = { initial: '', medial: [], final: [] };

/**
 * The jamo in Unicode's order, as the keys type them (compatibility jamo): the 19 consonants that start a
 * syllable, the 21 vowels, and the 27 consonants that end one (ㄸ ㅃ ㅉ never do).
 */
export const INITIALS = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
export const MEDIALS = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
export const FINALS = 'ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ';

const index = (jamo: string): ReadonlyMap<string, number> => new Map(Array.from(jamo, (ch, i) => [ch, i]));
const initials = index(INITIALS);
const medials = index(MEDIALS);
const finals = index(FINALS);
const FIRST_SYLLABLE = 0xac00;

export interface HangulTable {
  /** Two jamo typed one after the other that make one, by the two: ㅗㅏ → ㅘ, ㄱㅅ → ㄳ. */
  readonly medialPairs: ReadonlyMap<string, string>;
  readonly finalPairs: ReadonlyMap<string, string>;
}

const pairs = (list: readonly string[] = []): Map<string, string> =>
  new Map(list.map((pair) => Array.from(pair)).filter((p) => p.length === 3).map(([a, b, c]) => [a! + b!, c!]));

export const hangulTable = (def: HangulTableDef): HangulTable => ({
  medialPairs: pairs(def.compoundMedials), finalPairs: pairs(def.compoundFinals),
});

const composing = (s: Syllable): boolean => s.initial !== '' || s.medial.length > 0;

const joined = (pairsOf: ReadonlyMap<string, string>, parts: readonly string[]): string =>
  (parts.length === 2 ? pairsOf.get(parts[0]! + parts[1]!) ?? parts.join('') : parts[0] ?? '');

/** The syllable as text: one block once it has an initial and a vowel, else the jamo typed so far (ㄷ, ㅘ). */
export const syllableText = (table: HangulTable, s: Syllable): string => {
  const medial = joined(table.medialPairs, s.medial);
  const final = joined(table.finalPairs, s.final);
  const l = initials.get(s.initial);
  const v = medials.get(medial);
  const t = final ? finals.get(final) : -1;
  if (l === undefined || v === undefined || t === undefined) return s.initial + medial + final;
  return String.fromCodePoint(FIRST_SYLLABLE + (l * medials.size + v) * (finals.size + 1) + t + 1);
};

/** A typed jamo: the syllable it makes, and what is sent first; null when it is not a jamo. */
export const addJamo = (table: HangulTable, s: Syllable, jamo: string): { sent: string; syllable: Syllable } | null => {
  const vowel = medials.has(jamo);
  if (!vowel && !initials.has(jamo) && !finals.has(jamo)) return null;
  const keep = (syllable: Syllable) => ({ sent: '', syllable });
  /** Send `done` and start `next`; a jamo that cannot start a syllable (a final alone) is sent with it. */
  const send = (done: Syllable, next: Syllable | null) => ({ sent: syllableText(table, done) + (next ? '' : jamo), syllable: next ?? NO_SYLLABLE });
  const start = (): Syllable | null => (vowel ? { ...NO_SYLLABLE, medial: [jamo] } : initials.has(jamo) ? { ...NO_SYLLABLE, initial: jamo } : null);
  const [m0] = s.medial;
  const [f0] = s.final;
  if (vowel) {
    if (!s.medial.length) return keep({ ...s, medial: [jamo] }); // ㄱ + ㅏ → 가 (or a vowel alone)
    if (!s.final.length) {
      return s.medial.length === 1 && table.medialPairs.has(m0! + jamo) ? keep({ ...s, medial: [m0!, jamo] }) : send(s, start());
    }
    // The final's last consonant starts the new syllable, if it can: 한 + ㅏ → 하 나.
    const moved = s.final[s.final.length - 1]!;
    if (!initials.has(moved)) return send(s, start());
    return send({ ...s, final: s.final.slice(0, -1) }, { ...NO_SYLLABLE, initial: moved, medial: [jamo] });
  }
  if (s.initial && s.medial.length) {
    if (!s.final.length && finals.has(jamo)) return keep({ ...s, final: [jamo] }); // 가 + ㄴ → 간
    if (s.final.length === 1 && table.finalPairs.has(f0! + jamo)) return keep({ ...s, final: [f0!, jamo] }); // 갑 + ㅅ → 값
  }
  // A consonant that cannot join sends the syllable and starts the next; with nothing composed it starts one.
  const next = start();
  if (!composing(s)) return next ? keep(next) : send(NO_SYLLABLE, null);
  return send(s, next);
};

/** ⌫: the last jamo off. */
export const removeJamo = (s: Syllable): Syllable =>
  (s.final.length ? { ...s, final: s.final.slice(0, -1) }
    : s.medial.length ? { ...s, medial: s.medial.slice(0, -1) } : NO_SYLLABLE);

const tables = builtOnce(hangulTable);
/** The keyboard's table, built once per table pack; none: the keys type as they are. */
const tableOf = ({ table }: ComposerContext): HangulTable | undefined => (table?.hangul ? tables(table.hangul) : undefined);

/** A conversion to Hanja (한자): asked for, then (with the converter's segments) shown in the bar. */
export interface Conversion {
  /** What the converter is asked about: the word's Hangul before the syllable, then the syllable. */
  readonly reading: string;
  /** The syllable being composed as it was, at the reading's end ('' for none). */
  readonly composed: string;
  /** What goes before the word, the word with its Hanja, then what follows it; null until the converter answers. */
  readonly segments: readonly Converted[] | null;
  /** Which segment is the word (the one with candidates). */
  readonly focus: number;
  /** The candidate picked so far. */
  readonly index: number;
}

/** The composer's state: the syllable being composed, and a conversion under way. */
export interface Hangul { readonly syllable: Syllable; readonly conversion: Conversion | null }
export const NO_HANGUL: Hangul = { syllable: NO_SYLLABLE, conversion: null };

const HANGUL = /^[\u3131-\u318e\uac00-\ud7a3]$/u;
/** The end of the word before the syllable that is Hangul (jamo or syllables), at most `room` characters. */
const hangulEnd = (before: string, room: number): string => {
  const chars = Array.from(before);
  let start = chars.length;
  while (start > 0 && chars.length - start < room && HANGUL.test(chars[start - 1]!)) start--;
  return chars.slice(start).join('');
};

const isConvert = (key: KeyDef): boolean => key.type === 'action' && key.action === 'convert';
const isKey = (key: KeyDef, name: string): boolean => key.type === 'key' && key.key === name;

/** The converted word: the conversion's focused segment, once the converter has answered. */
const wordOf = (conversion: Conversion | null): Converted | undefined => conversion?.segments?.[conversion.focus];

const length = (text: string): number => Array.from(text).length;

/**
 * A candidate picked: a Backspace for each syllable typed from the word's start to the composition, then
 * the Hanja and what followed the word. The composition stays, unless it was part of the word.
 */
const pickHanja = (h: Hangul, text: string, index: number): ComposerResult<Hangul> => {
  const { conversion } = h;
  const word = wordOf(conversion);
  if (!conversion?.segments || !word || word.candidates[index] !== text) return { state: h, effects: [] };
  const chars = Array.from(conversion.reading);
  const start = conversion.segments.slice(0, conversion.focus).reduce((n, s) => n + length(s.reading), 0);
  const end = start + length(word.reading);
  const typed = chars.length - length(conversion.composed); // before the composition: in the field, or the bar's word
  const converted = end > typed; // the composition is part of the word
  if (converted && end !== chars.length) return { state: h, effects: [] };
  const back = Array.from({ length: Math.max(0, typed - start) }, (): Effect => ({ kind: 'key', key: 'Backspace' }));
  return {
    state: converted ? NO_HANGUL : { syllable: h.syllable, conversion: null },
    effects: [...back, { kind: 'text', text: text + (converted ? '' : chars.slice(end, typed).join('')) }],
    learned: { reading: word.reading, lengths: [length(word.reading)], choices: [index], texts: [text] },
  };
};

/** A press while the bar shows a conversion; null: it ends, and the key acts as it would. */
const pressConverting = (h: Hangul, conversion: Conversion, key: KeyDef): ComposerResult<Hangul> | null => {
  const segments = conversion.segments!;
  const candidates = segments[conversion.focus]!.candidates;
  if ((key.type === 'char' && key.char === ' ') || isConvert(key)) {
    return { state: { ...h, conversion: { ...conversion, index: (conversion.index + 1) % candidates.length } }, effects: [] };
  }
  if (isKey(key, 'Enter')) return pickHanja(h, candidates[conversion.index]!, conversion.index);
  if (isKey(key, 'ArrowLeft') || isKey(key, 'ArrowRight')) {
    // The word with Hanja before it or after it.
    const lengths = segments.map((s) => length(s.reading));
    return { state: h, effects: [], request: { kind: 'convert', lengths, resize: [conversion.focus, isKey(key, 'ArrowLeft') ? -1 : 1] } };
  }
  return isKey(key, 'Backspace') ? { state: { ...h, conversion: null }, effects: [] } : null;
};

export const hangul2Set: Composer<Hangul> = {
  empty: NO_HANGUL,
  inline: true,
  // A conversion asked for counts too: sending what waits ends it.
  composing: (h) => composing(h.syllable) || h.conversion !== null,
  press: (h, key, input, ctx) => {
    const table = tableOf(ctx);
    if (!table) return null;
    if (h.conversion?.segments) {
      const converting = pressConverting(h, h.conversion, key);
      if (converting) return converting;
    }
    // Typing on: a conversion ends (one still asked for too), and the key acts.
    const s = h.syllable;
    const { typed } = input;
    if (isConvert(key)) {
      const composed = composing(s) ? syllableText(table, s) : '';
      const reading = hangulEnd(ctx.before ?? '', MAX_READING - Array.from(composed).length) + composed;
      if (!reading) return { state: { syllable: s, conversion: null }, effects: [] };
      return { state: { syllable: s, conversion: { reading, composed, segments: null, focus: 0, index: 0 } }, effects: [], request: { kind: 'convert' } };
    }
    if (typed !== undefined) {
      const added = addJamo(table, s, typed);
      return added && { state: { syllable: added.syllable, conversion: null }, effects: added.sent ? [{ kind: 'text', text: added.sent }] : [] };
    }
    return isKey(key, 'Backspace') && composing(s) ? { state: { syllable: removeJamo(s), conversion: null }, effects: [] } : null;
  },
  flush: (h, ctx) => {
    const table = tableOf(ctx);
    const text = table && composing(h.syllable) ? syllableText(table, h.syllable) : '';
    return { state: NO_HANGUL, effects: text ? [{ kind: 'text', text }] : [] };
  },
  show: (h, ctx) => {
    const word = wordOf(h.conversion);
    if (h.conversion?.segments && word) {
      const { segments, focus, index } = h.conversion;
      return {
        preedit: {
          segments: segments.map((s) => s.reading), focus, candidates: word.candidates, selected: index,
          ...(word.notes ? { notes: word.notes } : {}),
        },
        labels: { ' ': 'next' },
        active: ['convert'],
      };
    }
    const table = tableOf(ctx);
    return { preedit: { before: table ? syllableText(table, h.syllable) : '', after: '' }, labels: {} };
  },
  convert: {
    reading: (h) => h.conversion?.reading ?? '',
    converted: (h, forReading, segments) => {
      const conversion = h.conversion;
      if (!conversion || conversion.reading !== forReading) return h; // it moved on
      const focus = segments.findIndex((s) => s.candidates.length > 0);
      if (focus < 0 || segments.map((s) => s.reading).join('') !== forReading) {
        return conversion.segments ? h : { ...h, conversion: null }; // nothing to convert to: the text stays as it is
      }
      return { ...h, conversion: { ...conversion, segments, focus, index: 0 } };
    },
    live: () => [],
    pick: pickHanja,
    cancel: (h) => (h.conversion ? { ...h, conversion: null } : h),
  },
};
