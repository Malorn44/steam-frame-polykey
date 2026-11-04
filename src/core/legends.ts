// What a key shows, as legends in slots: one model for every arrangement the view draws, so the view
// has one renderer and a pack (later) one way to say what goes where. Pure; the view decides icons
// (they are UI) and passes the result in.
//
//   tl  t  tr
//   l   c   r      c is the label; the others are small legends round it.
//   bl  b  br
//
// The arrangement says how the slots sit on the key (each has its own insets today): plain (the label in
// the middle, a long-press character top right), stack (Shift above, the label at the bottom), tri
// (Shift and Fn above, the label at the bottom), quad (a JIS key's four legends) and edges (flick hints
// at the edges).

import { normalizeFn, type KeyDef, type LegendDef, type LegendSlot } from './catalog.js';
import { charText, keyLabel, type Mods } from './keyboard.js';
import { pageLabel } from './pages.js';

export type SlotName = LegendSlot;
export type Arrangement = 'plain' | 'stack' | 'tri' | 'quad' | 'edges';

/**
 * A legend's size, as a size role: key (the key's own size, as its label), dual (a JIS key's current
 * character), legend (Shift, Fn, a JIS key's other legends, the long-press character), hint (flick
 * hints, 大⇔小), sub (the digit beneath abc).
 */
export type LegendSize = 'key' | 'dual' | 'legend' | 'hint' | 'sub';
/** Its colour: text, legend (dimmer) or fn. */
export type Tone = 'text' | 'legend' | 'fn';

export type Legend =
  /** Text; boxed: in a dotted box (the layout lists it); under: a line beneath it, in the flow. */
  | { kind: 'text'; text: string; size: LegendSize; tone: Tone; boxed: boolean; under?: Legend }
  | { kind: 'icon'; icon: string }
  /** The 12-key mode key's あ a: now is the part for the current mode (bold). */
  | { kind: 'pair'; parts: readonly [string, string]; now: 0 | 1 }
  /** ゛゜ side by side (each boxed when listed), with a line beneath. */
  | { kind: 'marks'; marks: readonly Legend[]; under: Legend };

export interface KeyLegends {
  readonly arrangement: Arrangement;
  readonly slots: Partial<Record<SlotName, Legend>>;
}

export interface LegendContext {
  /** 英数 mode (the keyboard's Latin side). */
  readonly latin: boolean;
  /** A JIS keyboard typing romaji: its Latin legends only. */
  readonly romaji: boolean;
  /** Which symbols page this is (0: not one), for the labels that follow it (core/pages.ts). */
  readonly symbols?: 0 | 1 | 2;
  /** What the current mode's letters are called (あいう, ABC), for the keys back to them. */
  readonly letters?: string | undefined;
  /** Flick hints (the option) for every flick key. */
  readonly hints: boolean;
  /** Characters drawn in a dotted box (the layout's dotted). */
  readonly dotted: ReadonlySet<string>;
  /** The icon the key draws now, if any (the view's choice). */
  readonly icon?: string | undefined;
  /** A label the page set for this key (e.g. Enter's 確定), in place of everything else. */
  readonly label?: string | undefined;
}

const NONE: KeyLegends = { arrangement: 'plain', slots: {} };

/** Small legends: the Shift character (not for letters) and the Fn variant. */
export const smallLegends = (key: KeyDef, mods: Mods): { sh: string; fn: string } => {
  if (key.type !== 'char' && key.type !== 'key') return { sh: '', fn: '' };
  const fnOn = mods.fn !== 'off' && key.fn;
  const fn = key.fn && !fnOn ? keyLabel(normalizeFn(key.fn), mods) : '';
  if (key.type !== 'char' || fnOn || !key.shift) return { sh: '', fn };
  const shown = charText(key, mods);
  return { sh: shown === key.shift ? key.char : key.shift, fn };
};

/** What the key shows now: what its fields put where, then its own legends (the page's label wins in c). */
export const keyLegends = (key: KeyDef, mods: Mods, ctx: LegendContext): KeyLegends => {
  const derived = fromFields(key, mods, ctx);
  const own = 'legends' in key ? key.legends : undefined;
  if (!own || derived === NONE) return derived;
  const slots = { ...derived.slots };
  for (const [slot, def] of Object.entries(own) as [SlotName, LegendDef | undefined][]) {
    if (def === undefined || (slot === 'c' && ctx.label !== undefined)) continue;
    const legend = def === null ? undefined : fromDef(def, slot, ctx);
    if (legend) slots[slot] = legend;
    else delete slots[slot];
  }
  return { arrangement: derived.arrangement, slots };
};

/** A pack's legend: a string is text at the slot's usual size and tone (a label in c, a small legend elsewhere). */
const fromDef = (def: Exclude<LegendDef, null>, slot: SlotName, ctx: LegendContext): Legend | undefined => {
  const spec = typeof def === 'string' ? { text: def } : def;
  const small = slot !== 'c';
  const text = (value: string, size: LegendSize, tone: Tone): Legend =>
    ({ kind: 'text', text: value, size, tone, boxed: ctx.dotted.has(value) });
  if (spec.parts) return { kind: 'pair', parts: spec.parts, now: ctx.latin ? 1 : 0 };
  // Beneath marks small as a hint (大⇔小); beneath text as the ABC keys' digit.
  if (spec.marks) return { kind: 'marks', marks: spec.marks.map((mark) => text(mark, 'key', 'text')), under: text(spec.under ?? '', 'hint', 'legend') };
  const under = spec.under === undefined ? undefined : text(spec.under, 'sub', 'legend');
  if (spec.text === undefined) return undefined;
  return {
    kind: 'text', text: spec.text, size: spec.size ?? (small ? 'legend' : 'key'), tone: spec.tone ?? (small ? 'legend' : 'text'),
    boxed: spec.boxed ?? ctx.dotted.has(spec.text), ...(under ? { under } : {}),
  };
};

/** What the key's fields (char, shift, fn, kana, hint, sub, flick) put where. */
const fromFields = (key: KeyDef, mods: Mods, ctx: LegendContext): KeyLegends => {
  const text = (value: string, size: LegendSize, tone: Tone): Legend =>
    ({ kind: 'text', text: value, size, tone, boxed: ctx.dotted.has(value) });

  if (key.type === 'gap') return NONE;
  if ((key.type === 'key' || key.type === 'action') && key.tall === 'bottom') return NONE; // the label is on the top half

  // A JIS key: Latin legends on the left, kana on the right (Shift above, plain below). The mode's side
  // is active and the character it types now is biggest; the rest are drawn like Shift legends.
  if (key.type === 'char' && key.kana) {
    // While Fn is on, a key with an Fn variant shows only that (F1).
    if (mods.fn !== 'off' && key.fn) return { arrangement: 'quad', slots: { c: text(keyLabel(normalizeFn(key.fn), mods), 'key', 'text') } };
    const letter = key.char.toLowerCase() !== key.char.toUpperCase();
    const shiftOn = mods.shift !== 'off';
    const latinNow = charText(key, mods);
    const onLatin = ctx.latin || ctx.romaji;
    const quarter = (value: string, active: boolean, current: boolean): Legend | undefined =>
      (value ? text(value, active && current ? 'dual' : 'legend', active && current ? 'text' : 'legend') : undefined);
    const ll = quarter(letter ? latinNow : key.char, onLatin, letter || latinNow === key.char);
    const ls = quarter(letter ? '' : key.shift ?? '', onLatin, !letter && latinNow !== key.char);
    const slots: Partial<Record<SlotName, Legend>> = {};
    if (ctx.romaji && key.fn) {
      // Romaji, with an Fn variant: as on the English keys, Shift top left, Fn top right, the character
      // beneath (the corners the kana leave free).
      if (ls) slots.tl = ls;
      slots.tr = text(keyLabel(normalizeFn(key.fn), mods), 'legend', 'fn');
      if (ll) slots.c = ll;
      return { arrangement: 'tri', slots };
    } else if (ctx.romaji) {
      // Romaji: no kana; the Latin legends in the middle like the English keys (a letter alone in the middle).
      if (ls) slots.t = ls;
      if (ll) slots[ls ? 'b' : 'c'] = ll;
    } else {
      if (ls) slots.tl = ls;
      if (ll) slots.bl = ll;
      const ks = quarter(key.kanaShift ?? '', !onLatin, shiftOn);
      const kl = quarter(key.kana, !onLatin, !shiftOn || !key.kanaShift);
      if (ks) slots.tr = ks;
      if (kl) slots.br = kl;
    }
    return { arrangement: 'quad', slots };
  }

  const label = ((): Legend => {
    if (ctx.label !== undefined) return text(ctx.label, 'key', 'text');
    if (key.type === 'flick' && (ctx.hints || key.hints)) return text(key.flick[0], 'key', 'text');
    if (ctx.icon) return { kind: 'icon', icon: ctx.icon };
    return text(pageLabel(key, { letters: ctx.letters, symbols: ctx.symbols ?? 0 }) ?? keyLabel(key, mods), 'key', 'text');
  })();
  // The ABC keys: the label with its digit small beneath (not with hints, which show the rest).
  const shown: Legend = key.type === 'flick' && key.sub && !(ctx.hints || key.hints) && label.kind === 'text'
    ? { ...label, under: text(key.sub, 'sub', 'legend') } : label;

  // Flick hints: each direction's kana small at the key's left, top, right and bottom edge.
  if (key.type === 'flick' && (ctx.hints || key.hints)) {
    const slots: Partial<Record<SlotName, Legend>> = { c: shown };
    (['l', 't', 'r', 'b'] as const).forEach((slot, i) => {
      const value = key.flick[i + 1];
      if (value) slots[slot] = text(value, 'hint', 'legend');
    });
    return { arrangement: 'edges', slots };
  }

  // With an Fn legend: Shift top left, Fn top right, the label beneath; with only a Shift legend: Shift
  // above the label, like a keycap.
  const small = smallLegends(key, mods);
  const slots: Partial<Record<SlotName, Legend>> = {};
  let arrangement: Arrangement = 'plain';
  if (small.fn) {
    arrangement = 'tri';
    if (small.sh) slots.tl = text(small.sh, 'legend', 'legend');
    slots.tr = text(small.fn, 'legend', 'fn');
  } else if (small.sh) {
    arrangement = 'stack';
    slots.t = text(small.sh, 'legend', 'legend');
  }
  slots.c = shown;
  // A long press's character, small in the top right (the QWERTY page's digits).
  if (key.type === 'char' && key.hint && !slots.tr) slots.tr = text(key.hint, 'legend', 'legend');
  return { arrangement, slots };
};
