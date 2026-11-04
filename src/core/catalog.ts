// Pack data as the page receives it from the sidecar (globalThis.__polykeyBoot); the shapes follow
// schema/pack.schema.json, which the sidecar has already validated.

import type { EmojiData, EmojiState } from './emoji.js';
import type { NamedKey } from './keycodes.js';

export type ModName = 'shift' | 'caps' | 'ctrl' | 'alt' | 'super' | 'fn';
export type ActionName = 'hide' | 'next-keyboard' | 'copy' | 'cut' | 'paste' | 'menu' | 'settings' | 'emoji' | 'dictate' | 'abc'
  | 'modify' | 'undo' | 'eisu' | 'kana' | 'symbols' | 'more-symbols';

/**
 * A key. On a JIS key, char and shift are its Latin legends (typed in 英数 mode) and kana and kanaShift
 * its kana legends (typed in かな mode).
 */
export type CharKey = {
  type: 'char'; char: string; shift?: string; long?: string[]; label?: string; w?: number; fn?: FnKey;
  kana?: string; kanaShift?: string;
  /** A small legend in the top right corner (what a long press offers, e.g. the digit on q). */
  hint?: string;
};
/** tall: the top or bottom half of a key two rows high (the JIS Enter); both halves are one key. */
export type Tall = 'top' | 'bottom';
export type NamedKeyKey = { type: 'key'; key: NamedKey; label?: string; w?: number; fn?: FnKey; tall?: Tall };
export type ModKey = { type: 'mod'; mod: ModName; label?: string; w?: number };
export type ActionKey = { type: 'action'; action: ActionName; label?: string; w?: number; tall?: Tall };
export type GapKey = { type: 'gap'; w: number };
/**
 * A 12-key flick key: [tap, left, up, right, down]; '' where a direction has nothing. `cycle` is what
 * tapping it again goes through when the keyboard's tapCycle option is on (default: its flicks).
 */
export type FlickKey = {
  type: 'flick'; flick: [string, string, string, string, string]; cycle?: string[]; label?: string; w?: number;
  /** Always show the other directions at the key's edges (whatever the flick hints option says). */
  hints?: boolean;
  /** A small legend beneath the label (the ABC keys' digit). */
  sub?: string;
};
export type KeyDef = CharKey | NamedKeyKey | ModKey | ActionKey | GapKey | FlickKey;
export type FnKey = string | Omit<CharKey, 'w' | 'fn'> | Omit<NamedKeyKey, 'w' | 'fn'>;

export interface Layout {
  id: string;
  name: string;
  toolbar?: ActionKey[];
  rows: (string | KeyDef)[][];
  /** Bigger key text and icons, as on a phone 12-key. */
  large?: boolean;
  /** What ゛゜小 cycles the last typed character through: each string is one cycle, e.g. "はばぱ". */
  modify?: string[];
  /** Legends drawn in a dotted box, as on JIS keycaps (punctuation, e.g. "、。・「」ー"). */
  dotted?: string;
}
/** Per-keyboard choices; a keyboard lists the ones it has, with its default. */
export interface KeyboardOptions {
  tapCycle?: boolean; candidatesLeft?: boolean; flickHints?: boolean; romajiInput?: boolean; qwertyLatin?: boolean;
}
export interface KeyboardDef {
  id: string; name: string; layout: string; language?: string; lexicon?: string; options?: KeyboardOptions;
  /**
   * direct: keys type at once. kana: a reading buffer, sent when confirmed (core/ime.ts). romaji: the
   * same buffer, letters turned into kana with the keyboard's table.
   */
  composer?: 'direct' | 'kana' | 'romaji';
  /** The romaji table (a table pack) for composer romaji, or a kana keyboard's romajiInput option. */
  table?: string;
  /** The layout shown in 英数 mode instead (the 12-key's ABC keys); default: the same layout. */
  latinLayout?: string;
  /** The 英数 layout with the qwertyLatin option on (the 12-key's QWERTY page). */
  qwertyLayout?: string;
  /** The layout the symbols key (?123) shows: numbers and symbols, typed in the current mode. */
  symbolsLayout?: string;
  /** The second symbols page (=\\<), and back to the first. */
  moreSymbolsLayout?: string;
  /** The engine that converts the reading (with composer kana). */
  converter?: 'anthy';
}
export interface ThemeColors {
  surface: string; key: string; keyText: string; modifier: string; accent: string;
  legend?: string; fnLegend?: string; hover?: string;
  /** Text on the accent (a selected candidate, a locked key); default surface. */
  accentText?: string;
  /** Text on the Fn colour (Fn locked); default surface. */
  fnText?: string;
  /** Hairlines between candidates, sections; default modifier. */
  divider?: string;
  /** The outline of an armed modifier, a hovered setting, a selected item; default accent. */
  ring?: string;
  /** The outline marking the current input mode (英数 / かな); default accent. */
  indicator?: string;
}
/** A conversion table: [input, output, pending letters?] rows (e.g. romaji to kana). */
/** entries: romaji to kana; cycles: what ゛゜小 does (layouts get theirs resolved into `modify`). */
export interface TableDef { id: string; name: string; entries?: [string, string, string?][]; cycles?: string[] }
export interface Theme {
  id: string; name: string; radius?: number; font?: string; followSteam?: boolean; colors: ThemeColors;
  /** dark (the default): pressed and raised states shift lighter; light: they shift darker. */
  tone?: 'dark' | 'light';
  /** Smaller radii: a focused segment (default 3), a dotted legend box (1), a switch (13). */
  radiusSmall?: number; radiusBox?: number; radiusPill?: number;
  /** Japanese fonts tried first where Japanese is drawn as text (default Noto Sans CJK JP). */
  fontCjk?: string;
  /** Shadows: popups and the drag ghost, and the larger emoji preview (CSS box-shadow values). */
  shadow?: string; shadowLarge?: string;
}
export interface Boot {
  catalog: {
    layouts: Record<string, Layout>; keyboards: Record<string, KeyboardDef>; themes: Record<string, Theme>;
    tables?: Record<string, TableDef>;
  };
  settings: {
    keyboards: string[]; theme: string; haptics?: boolean; suggestions?: boolean;
    /** The user's choices, by keyboard id. */
    keyboardOptions?: Record<string, KeyboardOptions>;
  };
  errors: string[];
  emoji?: EmojiData | null;
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
