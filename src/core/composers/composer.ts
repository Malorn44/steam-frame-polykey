// What every composer is: a pure module that takes the bar's state and a press, and gives back the new
// state, text to send now, and what the bar shows. The bar controller (src/bar.ts) is the same for all
// of them: a key a composer does not take sends what waits first, then acts as usual; it sends commits,
// draws the bar, asks the keyboard's converter (sidecar/polykey/converters/) and flushes on a keyboard
// switch. The registry is index.ts.

import type { KeyDef, KeyboardOptions, Layout, TableDef } from '../catalog.js';
import type { Effect } from '../keyboard.js';

/**
 * `build` run once per pack object (a table, a layout) and kept for as long as the object is: what a
 * composer makes of its keyboard's packs (a romaji table, the ゛゜小 cycles, Hangul's pairs).
 */
export const builtOnce = <K extends object, V>(build: (source: K) => V): ((source: K) => V) => {
  const built = new WeakMap<K, V>();
  return (source) => {
    if (!built.has(source)) built.set(source, build(source));
    return built.get(source) as V;
  };
};

/** What a press carries: the character a flick chose, or the text a typed key makes (Shift applied). */
export interface ComposerInput { readonly flicked?: string; readonly typed?: string }

/** What a composer reads besides the press: the keyboard's options, its table and its main layout. */
export interface ComposerContext {
  readonly options: Required<KeyboardOptions>;
  /** The table the keyboard names (its `table`), if the catalog has it. */
  readonly table: TableDef | undefined;
  /** The keyboard's main layout (its ゛゜小 cycles, for one). */
  readonly layout: Layout | undefined;
}

/** A segment of a conversion, as the converter gives it. */
export interface Converted { readonly reading: string; readonly candidates: readonly string[] }

/** What the bar asks the converter for after a press: live candidates, or a conversion (re-cut, resized). */
export type ConverterRequest =
  | { readonly kind: 'live' }
  | { readonly kind: 'convert'; readonly lengths?: readonly number[]; readonly resize?: readonly [number, number] };

/** The longest reading a converter is asked about, in characters; the sidecar refuses longer (converters/engine.py). */
export const MAX_READING = 64;

/** A sent conversion or prediction, for the converter to learn (picked candidates come first next time). */
export type Learned =
  | { readonly reading: string; readonly lengths: readonly number[]; readonly choices: readonly number[]; readonly texts: readonly string[] }
  | { readonly reading: string; readonly prediction: string };

/** What the converter last said about the reading while typing: its conversion and predictions. */
export interface LiveSource { readonly reading: string; readonly segments: readonly Converted[]; readonly predictions: readonly string[] }

export interface ComposerResult<S> {
  readonly state: S;
  /** Sent now, in order (a committed syllable, a confirmed reading). */
  readonly effects: Effect[];
  readonly request?: ConverterRequest;
  readonly learned?: Learned;
}

/**
 * What the bar shows: while typing, the text before and after the caret (the converter's live
 * candidates beside it); while converting, the segments with one focused and its candidates.
 */
export type Preedit =
  | { readonly before: string; readonly after: string }
  | { readonly segments: readonly string[]; readonly focus: number; readonly candidates: readonly string[]; readonly selected: number };

export interface Shown {
  readonly preedit: Preedit;
  /**
   * Keys whose label follows the state, by key id (' ', Enter, kana), as label names (convert,
   * confirm). The keyboard's language pack spells them; a name it does not spell leaves the key as it is.
   */
  readonly labels: Readonly<Record<string, string>>;
}

/** The converter side of a composer that has one: what to convert, and what to do with the answer. */
export interface Converting<S> {
  /** What the converter is asked about now ('' for nothing). */
  reading(state: S, ctx: ComposerContext): string;
  /** A conversion came back for `forReading`; ignored when the state has moved on. */
  converted(state: S, forReading: string, segments: readonly Converted[]): S;
  /** The bar's candidates while typing, from the converter's answer (none yet: empty lists). */
  live(forReading: string, segments: readonly Converted[], predictions: readonly string[]): string[];
  /** A candidate picked in the bar; `source` is what the live candidates came from, if they are current. */
  pick(state: S, text: string, index: number, source: LiveSource | null): ComposerResult<S>;
}

/**
 * A composer. Its members are methods, so the registry can hold composers of different states as
 * Composer<unknown>; the bar keeps each state with the composer that made it.
 */
export interface Composer<S> {
  /** The state with nothing composed. */
  readonly empty: S;
  composing(state: S): boolean;
  /** Whether a key with two sets of legends (JIS) types its Latin ones (romaji input); none: it types its own. */
  latinKeys?(ctx: ComposerContext): boolean;
  /** A press; null: not for the composer (the bar sends what waits first, then the key acts as usual). */
  press(state: S, key: KeyDef, input: ComposerInput, ctx: ComposerContext): ComposerResult<S> | null;
  /** Send everything that waits, as it stands. */
  flush(state: S, ctx: ComposerContext): ComposerResult<S>;
  show(state: S, ctx: ComposerContext): Shown;
  /** End anything waiting on the next press (a tap cycle), keeping what is composed. */
  pause?(state: S): S;
  /** Dictated text into the composition, for its candidates; null when it cannot take it (it is then sent at once). */
  insert?(state: S, text: string, ctx: ComposerContext): ComposerResult<S> | null;
  convert?: Converting<S>;
}
