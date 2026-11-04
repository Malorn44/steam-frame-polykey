// Japanese input with a reading buffer. Pure. Kana go into the buffer (shown in the bar), not into
// the app; nothing is sent until it is confirmed: 確定 (Enter) sends the reading as it is, or 変換
// (Space) converts it into segments whose candidates are picked one segment at a time, and the
// converted text is sent once the last segment is picked or confirmed. While only typing, live candidates
// (the best conversion and predictions) can be picked to send at once.
//
// Keys while typing: ⌫ deletes in the buffer, ← → move the caret (→ first ends an open tap cycle),
// ゛゜小 changes the kana before the caret, ↶ steps a tap cycle back. While converting: 変換 = next
// candidate, ← → shorten or lengthen the focused segment, ⌫ or ↶ go back to the reading, 確定 confirms the
// focused segment and moves to the next (on the last, it sends).
// Any other key sends the buffer first, then acts as usual (the caller does that on null).
//
// Typed keys (a JIS kana key, or a letter on the romaji keyboard) go into the buffer too: with a romaji
// table, letters turn into kana as they complete an entry (ka → か) and wait while they could still
// grow (n); they are settled (n → ん) before converting or sending. ゛ and ゜ join the kana before them.
//
// かな while typing (無変換's job on a Windows keyboard) shows the reading as カタカナ, then ﾊﾝｶｸ, then
// ひらがな again; 確定 sends it in that form. While converting it goes back to the reading, in カタカナ.

import type { FlickKey, KeyDef } from './catalog.js';
import { inForm, nextForm, toKatakana, type Form } from './forms.js';
import { feedRomaji, isRomaji, type RomajiTable } from './romaji.js';
import { UNDO, type Effect } from './keyboard.js';

/** The longest reading the sidecar converts. */
export const MAX_READING = 64;

export interface Segment {
  readonly reading: string;
  readonly candidates: readonly string[];
  readonly index: number;
}

export interface Ime {
  /** The reading, one kana per entry; not sent yet. */
  readonly chars: readonly string[];
  readonly caret: number;
  /** An open tap cycle (tapCycle on): tapping the same key again replaces the kana before the caret. */
  readonly cycle: { readonly key: string; readonly chars: readonly string[]; readonly index: number } | null;
  /** While converting: the segments (each with its picked candidate) and the focused one. */
  readonly segments: readonly Segment[] | null;
  readonly focus: number;
  /** How the reading is shown and sent (かな cycles it); editing goes back to ひらがな. */
  readonly form: Form;
}
export const NO_IME: Ime = { chars: [], caret: 0, cycle: null, segments: null, focus: 0, form: 'hiragana' };

/** What the caller should ask the converter for after a press. */
export type ImeRequest =
  | { readonly kind: 'live' }
  | { readonly kind: 'convert'; readonly lengths?: readonly number[]; readonly resize?: readonly [number, number] };

/** A sent conversion, for the converter to learn (picked candidates come first next time). */
export interface Learned {
  readonly reading: string;
  readonly lengths: readonly number[];
  readonly choices: readonly number[];
  readonly texts: readonly string[];
}

export interface ImeResult {
  readonly ime: Ime;
  readonly effects: Effect[];
  readonly request?: ImeRequest;
  readonly learned?: Learned;
}

export const reading = (ime: Ime): string => ime.chars.join('');
export const composing = (ime: Ime): boolean => ime.chars.length > 0;
/** What confirming sends now: the picked candidates while converting, else the reading in its form. */
export const converted = (ime: Ime): string =>
  (ime.segments ? ime.segments.map((s) => s.candidates[s.index] ?? s.reading).join('') : inForm(reading(ime), ime.form));


const commit = (ime: Ime): ImeResult => ({
  ime: NO_IME,
  effects: composing(ime) ? [{ kind: 'text', text: converted(ime) }] : [],
  request: { kind: 'live' },
  ...(ime.segments ? { learned: {
    reading: reading(ime),
    lengths: ime.segments.map((s) => Array.from(s.reading).length),
    choices: ime.segments.map((s) => s.index),
    texts: ime.segments.map((s) => s.candidates[s.index] ?? s.reading),
  } } : {}),
});

const insert = (ime: Ime, text: string, cycle: Ime['cycle'] = null): Ime => {
  if (ime.chars.length >= MAX_READING) return ime;
  const chars = [...ime.chars.slice(0, ime.caret), text, ...ime.chars.slice(ime.caret)];
  return { ...ime, chars, caret: ime.caret + 1, cycle, form: 'hiragana' };
};
const replaceBefore = (ime: Ime, text: string, cycle: Ime['cycle'] = null): Ime => {
  if (ime.caret === 0) return ime;
  const chars = [...ime.chars];
  chars[ime.caret - 1] = text;
  return { ...ime, chars, cycle, form: 'hiragana' };
};
const step = (ime: Ime, by: 1 | -1): ImeResult => {
  const cycle = ime.cycle!;
  const index = (cycle.index + by + cycle.chars.length) % cycle.chars.length;
  return { ime: replaceBefore(ime, cycle.chars[index]!, { ...cycle, index }), effects: [], request: { kind: 'live' } };
};

const typeFlick = (ime: Ime, key: FlickKey, flicked: string | undefined, tapCycle: boolean): ImeResult => {
  if (flicked !== undefined) return { ime: insert(ime, flicked), effects: [], request: { kind: 'live' } };
  const id = key.flick[0];
  if (tapCycle && ime.cycle?.key === id) return step(ime, 1);
  const chars = key.cycle ?? key.flick.filter(Boolean);
  const cycle = tapCycle && chars.length > 1 ? { key: id, chars, index: 0 } : null;
  return { ime: insert(ime, id, cycle), effects: [], request: { kind: 'live' } };
};

/** ゛ and ゜ typed after a kana join it (か゛ → が); otherwise they stay as typed. */
const pairs = (s: string): Map<string, string> => new Map(Array.from(s.matchAll(/(.)(.)/gu), (m) => [m[1]!, m[2]!]));
const VOICED = pairs('かがきぎくぐけげこごさざしじすずせぜそぞただちぢつづてでとどはばひびふぶへべほぼうゔ');
const SEMIVOICED = pairs('はぱひぴふぷへぺほぽ');

/** Put typed text in the buffer: romaji letters convert as they complete; ゛ ゜ join the kana before. */
const insertTyped = (ime: Ime, text: string, romaji: RomajiTable | undefined): Ime => {
  const join = text === '゛' ? VOICED : text === '゜' ? SEMIVOICED : null;
  const before = ime.chars[ime.caret - 1];
  if (join && before && join.has(before)) return replaceBefore(ime, join.get(before)!);
  let next = ime;
  for (const ch of Array.from(text)) next = insert(next, ch);
  if (!romaji || !isRomaji(text)) return next;
  let start = next.caret;
  while (start > 0 && isRomaji(next.chars[start - 1]!) && next.caret - start < 8) start--;
  const { out, rest } = feedRomaji(next.chars.slice(start, next.caret).join(''), romaji);
  const middle = [...Array.from(out), ...Array.from(rest)];
  return { ...next, chars: [...next.chars.slice(0, start), ...middle, ...next.chars.slice(next.caret)], caret: start + middle.length };
};

/** Settle letters still waiting (n → ん) before converting or sending. */
export const settleRomaji = (ime: Ime, romaji: RomajiTable | undefined): Ime => {
  if (!romaji || !ime.chars.some(isRomaji)) return ime;
  const chars: string[] = [];
  let run = '';
  let caret = 0;
  const flushRun = (): void => {
    if (run) chars.push(...Array.from(feedRomaji(run, romaji, true).out));
    run = '';
  };
  ime.chars.forEach((ch, i) => {
    if (i === ime.caret) {
      flushRun();
      caret = chars.length;
    }
    if (isRomaji(ch)) run += ch;
    else {
      flushRun();
      chars.push(ch);
    }
  });
  flushRun();
  if (ime.caret >= ime.chars.length) caret = chars.length;
  return { ...ime, chars, caret };
};

const isKey = (key: KeyDef, name: string): boolean => key.type === 'key' && key.key === name;
const isAction = (key: KeyDef, name: string): boolean => key.type === 'action' && key.action === name;
const isSpace = (key: KeyDef): boolean => key.type === 'char' && key.char === ' ';

/** What a press carries: the kana a flick chose, or the text a typed key makes (Shift applied). */
export interface ImeInput { readonly flicked?: string; readonly typed?: string }
/** The keyboard's tables: ゛゜小's cycles, and romaji (the romaji keyboard). */
export interface ImeTables { readonly modify: ReadonlyMap<string, string>; readonly romaji?: RomajiTable }

/** A press on a keyboard with a reading buffer; null: not for the buffer (send it first, then act). */
export const pressIme = (
  ime: Ime,
  key: KeyDef,
  input: ImeInput,
  options: { tapCycle: boolean },
  tables: ImeTables,
): ImeResult | null => {
  const { flicked, typed } = input;
  const { modify, romaji } = tables;
  const typing = typed !== undefined && key.type === 'char' && !isSpace(key);
  if (ime.segments) {
    if (key.type === 'flick' || isAction(key, 'modify') || typing) {
      // Typing on after a conversion: send it, then start a new reading.
      const sent = commit(ime);
      const next = pressIme(NO_IME, key, input, options, tables);
      return next ? { ...next, effects: [...sent.effects, ...next.effects] } : sent;
    }
    if (isSpace(key)) {
      const segments = ime.segments.map((s, i) =>
        (i === ime.focus && s.candidates.length ? { ...s, index: (s.index + 1) % s.candidates.length } : s));
      return { ime: { ...ime, segments }, effects: [] };
    }
    if (isKey(key, 'ArrowLeft') || isKey(key, 'ArrowRight')) {
      const lengths = ime.segments.map((s) => Array.from(s.reading).length);
      return { ime, effects: [], request: { kind: 'convert', lengths, resize: [ime.focus, isKey(key, 'ArrowLeft') ? -1 : 1] } };
    }
    // 確定 confirms the focused segment as it is and moves on; after the last, everything is sent.
    if (isKey(key, 'Enter')) return ime.focus + 1 < ime.segments.length ? { ime: { ...ime, focus: ime.focus + 1 }, effects: [] } : commit(ime);
    if (isKey(key, 'Backspace') || isAction(key, 'undo')) {
      return { ime: { ...ime, segments: null, focus: 0 }, effects: [], request: { kind: 'live' } };
    }
    if (isAction(key, 'kana')) return { ime: { ...ime, segments: null, focus: 0, form: 'katakana' }, effects: [], request: { kind: 'live' } };
    return null;
  }

  if (key.type === 'flick') return typeFlick(ime, key, flicked, options.tapCycle);
  if (typing) return { ime: insertTyped({ ...ime, cycle: null }, typed, romaji), effects: [], request: { kind: 'live' } };
  if (!composing(ime)) {
    if (isAction(key, 'modify')) return { ime, effects: [] };
    if (isAction(key, 'undo')) return { ime, effects: [UNDO] };
    if (isAction(key, 'kana')) return { ime, effects: [] };
    return null;
  }
  if (isAction(key, 'modify')) {
    const next = modify.get(ime.chars[ime.caret - 1] ?? '');
    return next ? { ime: replaceBefore(ime, next), effects: [], request: { kind: 'live' } } : { ime, effects: [] };
  }
  if (isAction(key, 'undo')) return ime.cycle ? step(ime, -1) : { ime, effects: [] };
  if (isAction(key, 'kana')) return { ime: { ...settleRomaji(ime, romaji), cycle: null, form: nextForm(ime.form) }, effects: [] };
  if (isKey(key, 'Backspace')) {
    if (ime.caret === 0) return { ime, effects: [] };
    const chars = [...ime.chars.slice(0, ime.caret - 1), ...ime.chars.slice(ime.caret)];
    return { ime: chars.length ? { ...ime, chars, caret: ime.caret - 1, cycle: null, form: 'hiragana' } : NO_IME, effects: [], request: { kind: 'live' } };
  }
  if (isKey(key, 'ArrowRight')) {
    if (ime.cycle) return { ime: { ...ime, cycle: null }, effects: [] };
    return { ime: { ...ime, caret: Math.min(ime.chars.length, ime.caret + 1) }, effects: [] };
  }
  if (isKey(key, 'ArrowLeft')) return { ime: { ...ime, caret: Math.max(0, ime.caret - 1), cycle: null }, effects: [] };
  if (isSpace(key)) return { ime: { ...settleRomaji(ime, romaji), cycle: null, form: 'hiragana' }, effects: [], request: { kind: 'convert' } };
  if (isKey(key, 'Enter')) return commit(settleRomaji(ime, romaji));
  return null;
};

/** Everything in the buffer, sent as it stands (another key, switching keyboards). */
export const flush = (ime: Ime, romaji?: RomajiTable): ImeResult => commit(settleRomaji(ime, romaji));

/** Start converting, or show a resized conversion; ignored if the reading changed meanwhile. */
export const withConversion = (ime: Ime, forReading: string, segments: readonly Omit<Segment, 'index'>[]): Ime => {
  if (reading(ime) !== forReading || !segments.length || segments.map((s) => s.reading).join('') !== forReading) return ime;
  return { ...ime, cycle: null, form: 'hiragana', segments: segments.map((s) => ({ ...s, index: 0 })), focus: Math.min(ime.focus, segments.length - 1) };
};

/**
 * A candidate picked in the bar. Converting: it becomes the focused segment's choice and the next
 * segment is focused; after the last one, everything is sent. Typing: a live candidate is sent at once.
 */
export const pickCandidate = (ime: Ime, text: string, index: number): ImeResult => {
  if (!ime.segments) return { ime: NO_IME, effects: [{ kind: 'text', text }], request: { kind: 'live' } };
  const segments = ime.segments.map((s, i) => (i === ime.focus ? { ...s, index } : s));
  const next = { ...ime, segments, focus: ime.focus + 1 };
  return next.focus >= segments.length ? commit(next) : { ime: next, effects: [] };
};

/** The bar's live candidates while typing: the best conversion, predictions, then the reading as hiragana and katakana. */
export const liveCandidates = (forReading: string, segments: readonly Omit<Segment, 'index'>[], predictions: readonly string[]): string[] => {
  const best = segments.length ? segments.map((s) => s.candidates[0] ?? s.reading).join('') : '';
  return [...new Set([best, ...predictions, forReading, toKatakana(forReading)].filter(Boolean))];
};
