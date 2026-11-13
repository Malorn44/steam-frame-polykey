// Pack data as the page receives it from the sidecar (globalThis.__polykeyBoot); the shapes follow
// packs/pack.schema.json, which the sidecar has already validated.

import type { ComposerId } from './composers/index.js';
import type { EmojiState, PickerSet } from './emoji.js';
import type { PackName } from './names.js';
import type { NamedKey } from './keycodes.js';

export type ModName = 'shift' | 'caps' | 'ctrl' | 'alt' | 'super' | 'fn';
export type ActionName = 'hide' | 'next-keyboard' | 'copy' | 'cut' | 'paste' | 'menu' | 'settings' | 'emoji' | 'next-set' | 'dictate' | 'abc'
  | 'modify' | 'undo' | 'eisu' | 'kana' | 'mode' | 'symbols' | 'more-symbols';

/** Where on a key a legend sits: c is the label; the rest are small legends round it. */
export type LegendSlot = 'tl' | 't' | 'tr' | 'l' | 'c' | 'r' | 'bl' | 'b' | 'br';
/**
 * A legend a pack puts in a slot (src/core/legends.ts): text, or null for none; or one of text, parts
 * (two halves, one per mode: the second bold in 英数 mode, あ a; on the mode key the current one marked
 * with the indicator bar, 한/영) or marks (゛゜, side by side), with what is drawn
 * small beneath it (under), and its size, tone and box when not the slot's default.
 */
export type LegendDef = string | null | {
  text?: string; parts?: [string, string]; marks?: string[]; under?: string;
  size?: 'key' | 'dual' | 'legend' | 'hint' | 'sub'; tone?: 'text' | 'legend' | 'fn'; boxed?: boolean;
};
/** A key's own legends, by slot: they replace what its other fields would put there. */
export type LegendDefs = Partial<Record<LegendSlot, LegendDef>>;

/**
 * A key. On a JIS key, char and shift are its Latin legends (typed in 英数 mode) and kana and kanaShift
 * its kana legends (typed in かな mode).
 */
export type CharKey = {
  type: 'char'; char: string; shift?: string; long?: string[]; label?: string; icon?: string | null; legends?: LegendDefs; w?: number; fn?: FnKey;
  kana?: string; kanaShift?: string;
  /** A small legend in the top right corner (what a long press offers, e.g. the digit on q). */
  hint?: string;
};
/**
 * tall: a piece of a key two or three rows high (top, middle, bottom); the pieces are one key. A pack
 * writes the key once (rows: 2 or 3, notch: the lower pieces that much narrower on the left, the JIS
 * Enter); the loader splits it, marking the top piece with span (its rows).
 */
export type Tall = 'top' | 'middle' | 'bottom';
export type NamedKeyKey = { type: 'key'; key: NamedKey; label?: string; icon?: string | null; legends?: LegendDefs; w?: number; fn?: FnKey; tall?: Tall; span?: number; notch?: number };
export type ModKey = { type: 'mod'; mod: ModName; label?: string; icon?: string | null; legends?: LegendDefs; w?: number };
export type ActionKey = { type: 'action'; action: ActionName; label?: string; icon?: string | null; legends?: LegendDefs; w?: number; tall?: Tall; span?: number; notch?: number };
export type GapKey = { type: 'gap'; w: number };
/**
 * A 12-key flick key: [tap, left, up, right, down]; '' where a direction has nothing. `cycle` is what
 * tapping it again goes through when the keyboard's tapCycle option is on (default: its flicks).
 */
export type FlickKey = {
  type: 'flick'; flick: [string, string, string, string, string]; cycle?: string[]; label?: string; legends?: LegendDefs; w?: number;
  /** Always show the other directions at the key's edges (whatever the flick hints option says). */
  hints?: boolean;
  /** A small legend beneath the label (the ABC keys' digit). */
  sub?: string;
};
export type KeyDef = CharKey | NamedKeyKey | ModKey | ActionKey | GapKey | FlickKey;
export type FnKey = string | Omit<CharKey, 'w' | 'fn'> | Omit<NamedKeyKey, 'w' | 'fn'>;

export interface Layout {
  id: string;
  name: PackName;
  toolbar?: ActionKey[];
  rows: (string | KeyDef)[][];
  /** The rows with 🌐 hidden, for when your list has one keyboard (the loader builds them from "alone"). */
  aloneRows?: (string | KeyDef)[][];
  /** Bigger key text and icons, as on a phone 12-key. */
  large?: boolean;
  /** Which keys draw icons: desktop, or phone (more icons; the default for large layouts). */
  iconSet?: 'desktop' | 'phone';
  /** Arrow keys as icons (default) or as text glyphs (←↑↓→, the JIS keyboard). */
  arrowStyle?: 'icon' | 'glyph';
  /** What ゛゜小 cycles the last typed character through: each string is one cycle, e.g. "はばぱ". */
  modify?: string[];
  /** Legends drawn in a dotted box, as on JIS keycaps (punctuation, e.g. "、。・「」ー"). */
  dotted?: string;
}
/** Per-keyboard choices; a keyboard lists the ones it has, with its default. */
export interface KeyboardOptions {
  tapCycle?: boolean; candidatesLeft?: boolean; flickHints?: boolean; romajiInput?: boolean; qwertyLatin?: boolean;
  /** Swipe typing, for a keyboard with features.swipe. */
  swipe?: boolean;
  /** On a keyboard with a reading: dictated text typed at once, not into the reading for candidates (not set by packs). */
  dictationCommit?: boolean;
}
/** What a keyboard can do beyond typing keys. swipe: swipe typing, decoded against this word list. */
export interface KeyboardFeatures { swipe?: { lexicon: string } }
/**
 * latin: the layout shown in 英数 mode instead (the 12-key's ABC keys), or two that the qwertyLatin
 * option picks between. symbols: the ?123 pages, the first opened by the symbols key and the second
 * reached with more-symbols (=\\<).
 */
export interface KeyboardPages { latin?: string | { flick: string; qwerty: string }; symbols?: string[] }

export interface KeyboardDef {
  id: string; name: PackName; layout: string; language?: string; lexicon?: string; options?: KeyboardOptions;
  features?: KeyboardFeatures;
  /**
   * How typing composes text in the bar (src/core/composers/): direct, keys type at once; kana, a
   * reading buffer, sent when confirmed; romaji, the same buffer, letters turned into kana with the table.
   */
  composer?: ComposerId;
  /** The composer's table (a table pack): romaji for composer romaji, or a kana keyboard's romajiInput option. */
  table?: string;
  /** The keyboard's other pages (src/core/pages.ts); layout is the main one. */
  pages?: KeyboardPages;
  /**
   * The keyboard's modes, the first its default: what each one's letters are called (あいう, ABC; read
   * by the keys back to them; default: the language's for the first), and which is its Latin mode (英数).
   */
  modes?: { id: string; letters?: string; latin?: boolean }[];
  /** Text the keyboard shows: idleHint, where candidates appear while there are none (default: the language's). */
  strings?: { idleHint?: string };
  /** The engine that converts what the composer reads (anthy): one of the sidecar's (sidecar/polykey/converters/). */
  converter?: string;
}
/**
 * A language (core/languages.ts): what the keyboards with its code call their letters (あいう, 한글), the
 * words their bar's keys show by label name (convert: 変換), their idle hint, and the language dictation
 * listens for (default: the id). A keyboard's own modes and strings win.
 */
export interface LanguageDef {
  id: string; name: PackName; letters?: string; labels?: Record<string, string>; idleHint?: string; dictation?: string;
  /** The bar draws its text in the theme's CJK fonts (fontCjk): Hangul, which the Frame's system font has none of. */
  cjk?: boolean;
}
export interface ThemeColors {
  surface: string; key: string; keyText: string; modifier: string; accent: string;
  legend?: string; fnLegend?: string; hover?: string;
  /** Text on the accent (a selected candidate, a locked key); default surface. */
  accentText?: string;
  /** Text on the Fn colour (Fn locked); default surface. */
  fnText?: string;
  /** Errors (a failed dictation, a pack that did not load); default the Fn colour. */
  error?: string;
  /** Hairlines between candidates, sections; default modifier. */
  divider?: string;
  /** The outline of an armed modifier, a hovered setting, a selected item; default accent. */
  ring?: string;
  /** The outline marking the current input mode (英数 / かな); default accent. */
  indicator?: string;
}
/**
 * Hangul composition (the hangul composer): the jamo in Unicode's order, a syllable's initial, medial and
 * final being its index in each, and the pairs typed one after the other that make one jamo ("ㅗㅏㅘ").
 */
export interface HangulTableDef { initials: string; medials: string; finals: string; compoundMedials?: string[]; compoundFinals?: string[] }
/**
 * A table: entries, romaji to kana ([input, output, pending letters?]); cycles, what ゛゜小 does (layouts
 * get theirs resolved into `modify`); or hangul, how jamo compose.
 */
export interface TableDef { id: string; name: PackName; entries?: [string, string, string?][]; cycles?: string[]; hangul?: HangulTableDef }
export interface Theme {
  id: string; name: PackName; radius?: number; font?: string; followSteam?: boolean; colors: ThemeColors;
  /** dark (the default): pressed and raised states shift lighter; light: they shift darker. */
  tone?: 'dark' | 'light';
  /** Smaller radii: a focused segment (default 3), a dotted legend box (1), a switch (13). */
  radiusSmall?: number; radiusPill?: number;
  /** Japanese fonts tried first where Japanese is drawn as text (default Noto Sans CJK JP). */
  fontCjk?: string;
  /** Shadows: popups and the drag ghost, and the larger emoji preview (CSS box-shadow values). */
  shadow?: string; shadowLarge?: string;
}
export interface Boot {
  catalog: {
    layouts: Record<string, Layout>; keyboards: Record<string, KeyboardDef>; themes: Record<string, Theme>;
    tables?: Record<string, TableDef>;
    /** Language packs, by code. */
    languages?: Record<string, LanguageDef>;
  };
  settings: {
    keyboards: string[]; theme: string; haptics?: boolean; suggestions?: boolean;
    /** Dictation, and continuous dictation (both off by default). */
    dictation?: boolean; dictationContinuous?: boolean;
    /** Install newer releases when found (on by default). */
    autoUpdate?: boolean;
    /** The user's choices, by keyboard id. */
    keyboardOptions?: Record<string, KeyboardOptions>;
  };
  errors: string[];
  /** The picker's sets (picker packs), in pack order; with none there is no picker, with one no mode key. */
  pickers?: PickerSet[];
  emojiState?: EmojiState;
}

/** A one-character string is shorthand for a char key. */
export const normalizeKey = (key: string | KeyDef): KeyDef => (typeof key === 'string' ? { type: 'char', char: key } : key);
export const normalizeFn = (key: FnKey): CharKey | NamedKeyKey =>
  (typeof key === 'string' ? { type: 'char', char: key } : key);

/** The boot data, if it has the expected shape. */
export const readBoot = (value: unknown): Boot | null => {
  const boot = value as Boot | undefined;
  return boot && typeof boot === 'object' && boot.catalog && boot.settings && Array.isArray(boot.settings.keyboards)
    ? boot
    : null;
};
