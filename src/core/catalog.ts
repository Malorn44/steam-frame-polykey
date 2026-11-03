// Pack data as the page receives it from the sidecar (globalThis.__polykeyBoot); the shapes follow
// schema/pack.schema.json, which the sidecar has already validated.

import type { EmojiData, EmojiState } from './emoji.js';
import type { NamedKey } from './keycodes.js';

export type ModName = 'shift' | 'caps' | 'ctrl' | 'alt' | 'super' | 'fn';
export type ActionName = 'hide' | 'next-keyboard' | 'copy' | 'cut' | 'paste' | 'menu' | 'settings' | 'emoji' | 'dictate' | 'abc'
  | 'modify' | 'undo';

export type CharKey = { type: 'char'; char: string; shift?: string; long?: string[]; label?: string; w?: number; fn?: FnKey };
export type NamedKeyKey = { type: 'key'; key: NamedKey; label?: string; w?: number; fn?: FnKey };
export type ModKey = { type: 'mod'; mod: ModName; label?: string; w?: number };
export type ActionKey = { type: 'action'; action: ActionName; label?: string; w?: number };
export type GapKey = { type: 'gap'; w: number };
/**
 * A 12-key flick key: [tap, left, up, right, down]; '' where a direction has nothing. `cycle` is what
 * tapping it again goes through when the keyboard's tapCycle option is on (default: its flicks).
 */
export type FlickKey = {
  type: 'flick'; flick: [string, string, string, string, string]; cycle?: string[]; label?: string; w?: number;
  /** Always show the other directions at the key's edges (whatever the flick hints option says). */
  hints?: boolean;
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
}
/** Per-keyboard choices; a keyboard lists the ones it has, with its default. */
export interface KeyboardOptions { tapCycle?: boolean; candidatesLeft?: boolean; flickHints?: boolean }
export interface KeyboardDef {
  id: string; name: string; layout: string; language?: string; lexicon?: string; options?: KeyboardOptions;
  /** direct: keys type at once; kana: a reading buffer, sent when confirmed (core/ime.ts). */
  composer?: 'direct' | 'kana';
  /** The engine that converts the reading (with composer kana). */
  converter?: 'anthy';
}
export interface ThemeColors {
  surface: string; key: string; keyText: string; modifier: string; accent: string;
  legend?: string; fnLegend?: string; hover?: string;
}
export interface Theme { id: string; name: string; radius?: number; font?: string; followSteam?: boolean; colors: ThemeColors }
export interface Boot {
  catalog: { layouts: Record<string, Layout>; keyboards: Record<string, KeyboardDef>; themes: Record<string, Theme> };
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
