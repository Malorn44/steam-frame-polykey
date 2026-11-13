// The hangul composer: Korean typed jamo by jamo, the syllable being composed shown in the bar and sent
// once the next jamo cannot join it. Pure. A syllable is Unicode's formula, 0xAC00 + (initial × 21 +
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

import type { HangulTableDef } from '../catalog.js';
import { builtOnce, type Composer, type ComposerContext } from './composer.js';

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

export const hangul: Composer<Syllable> = {
  empty: NO_SYLLABLE,
  composing,
  latinKeys: () => false,
  press: (s, key, { typed }, ctx) => {
    const table = tableOf(ctx);
    if (!table) return null;
    if (typed !== undefined) {
      const added = addJamo(table, s, typed);
      return added && { state: added.syllable, effects: added.sent ? [{ kind: 'text', text: added.sent }] : [] };
    }
    return key.type === 'key' && key.key === 'Backspace' && composing(s) ? { state: removeJamo(s), effects: [] } : null;
  },
  flush: (s, ctx) => {
    const table = tableOf(ctx);
    const text = table && composing(s) ? syllableText(table, s) : '';
    return { state: NO_SYLLABLE, effects: text ? [{ kind: 'text', text }] : [] };
  },
  show: (s, ctx) => {
    const table = tableOf(ctx);
    return { preedit: { before: table ? syllableText(table, s) : '', after: '' }, labels: {} };
  },
};
