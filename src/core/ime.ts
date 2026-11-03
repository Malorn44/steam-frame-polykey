// Japanese input with a reading buffer. Pure. Kana go into the buffer (shown in the bar), not into
// the app; nothing is sent until it is confirmed: 確定 (Enter) sends the reading as it is, or 変換
// (Space) converts it into segments whose candidates are picked one segment at a time, and the
// converted text is sent once the last segment is picked (or 確定). While only typing, live candidates
// (the best conversion and predictions) can be picked to send at once.
//
// Keys while typing: ⌫ deletes in the buffer, ← → move the caret (→ first ends an open tap cycle),
// ゛゜小 changes the kana before the caret, ↶ steps a tap cycle back. While converting: 変換 = next
// candidate, ← → shorten or lengthen the focused segment, ⌫ or ↶ go back to the reading, 確定 sends.
// Any other key sends the buffer first, then acts as usual (the caller does that on null).

import type { FlickKey, KeyDef } from './catalog.js';
import { MODIFIER, chord, keyForChar } from './keycodes.js';
import type { Effect } from './keyboard.js';

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
}
export const NO_IME: Ime = { chars: [], caret: 0, cycle: null, segments: null, focus: 0 };

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
/** What confirming sends now: the picked candidates while converting, else the reading. */
export const converted = (ime: Ime): string =>
  (ime.segments ? ime.segments.map((s) => s.candidates[s.index] ?? s.reading).join('') : reading(ime));

const z = keyForChar('z');
/** ↶ with nothing in the buffer: undo in the app. */
const UNDO: Effect = { kind: 'chord', events: chord([MODIFIER.ctrl], z ? z.code : 29) };

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
  return { ...ime, chars, caret: ime.caret + 1, cycle };
};
const replaceBefore = (ime: Ime, text: string, cycle: Ime['cycle'] = null): Ime => {
  if (ime.caret === 0) return ime;
  const chars = [...ime.chars];
  chars[ime.caret - 1] = text;
  return { ...ime, chars, cycle };
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

const isKey = (key: KeyDef, name: string): boolean => key.type === 'key' && key.key === name;
const isAction = (key: KeyDef, name: string): boolean => key.type === 'action' && key.action === name;
const isSpace = (key: KeyDef): boolean => key.type === 'char' && key.char === ' ';

/** A press on a keyboard with a reading buffer; null: not for the buffer (send it first, then act). */
export const pressIme = (
  ime: Ime,
  key: KeyDef,
  flicked: string | undefined,
  options: { tapCycle: boolean },
  modify: ReadonlyMap<string, string>,
): ImeResult | null => {
  if (ime.segments) {
    if (key.type === 'flick' || isAction(key, 'modify')) {
      // Typing on after a conversion: send it, then start a new reading.
      const sent = commit(ime);
      const next = pressIme(NO_IME, key, flicked, options, modify);
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
    if (isKey(key, 'Enter')) return commit(ime);
    if (isKey(key, 'Backspace') || isAction(key, 'undo')) {
      return { ime: { ...ime, segments: null, focus: 0 }, effects: [], request: { kind: 'live' } };
    }
    return null;
  }

  if (key.type === 'flick') return typeFlick(ime, key, flicked, options.tapCycle);
  if (!composing(ime)) {
    if (isAction(key, 'modify')) return { ime, effects: [] };
    if (isAction(key, 'undo')) return { ime, effects: [UNDO] };
    return null;
  }
  if (isAction(key, 'modify')) {
    const next = modify.get(ime.chars[ime.caret - 1] ?? '');
    return next ? { ime: replaceBefore(ime, next), effects: [], request: { kind: 'live' } } : { ime, effects: [] };
  }
  if (isAction(key, 'undo')) return ime.cycle ? step(ime, -1) : { ime, effects: [] };
  if (isKey(key, 'Backspace')) {
    if (ime.caret === 0) return { ime, effects: [] };
    const chars = [...ime.chars.slice(0, ime.caret - 1), ...ime.chars.slice(ime.caret)];
    return { ime: chars.length ? { ...ime, chars, caret: ime.caret - 1, cycle: null } : NO_IME, effects: [], request: { kind: 'live' } };
  }
  if (isKey(key, 'ArrowRight')) {
    if (ime.cycle) return { ime: { ...ime, cycle: null }, effects: [] };
    return { ime: { ...ime, caret: Math.min(ime.chars.length, ime.caret + 1) }, effects: [] };
  }
  if (isKey(key, 'ArrowLeft')) return { ime: { ...ime, caret: Math.max(0, ime.caret - 1), cycle: null }, effects: [] };
  if (isSpace(key)) return { ime: { ...ime, cycle: null }, effects: [], request: { kind: 'convert' } };
  if (isKey(key, 'Enter')) return commit(ime);
  return null;
};

/** Everything in the buffer, sent as it stands (another key, switching keyboards). */
export const flush = (ime: Ime): ImeResult => commit(ime);

/** Start converting, or show a resized conversion; ignored if the reading changed meanwhile. */
export const withConversion = (ime: Ime, forReading: string, segments: readonly Omit<Segment, 'index'>[]): Ime => {
  if (reading(ime) !== forReading || !segments.length || segments.map((s) => s.reading).join('') !== forReading) return ime;
  return { ...ime, cycle: null, segments: segments.map((s) => ({ ...s, index: 0 })), focus: Math.min(ime.focus, segments.length - 1) };
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

const toKatakana = (text: string): string => text.replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));

/** The bar's live candidates while typing: the best conversion, predictions, then the reading as hiragana and katakana. */
export const liveCandidates = (forReading: string, segments: readonly Omit<Segment, 'index'>[], predictions: readonly string[]): string[] => {
  const best = segments.length ? segments.map((s) => s.candidates[0] ?? s.reading).join('') : '';
  return [...new Set([best, ...predictions, forReading, toKatakana(forReading)].filter(Boolean))];
};
