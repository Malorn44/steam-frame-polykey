// Emoji picker logic. Pure. Data comes from packs/emoji/emoji.data (Unicode Emoji 15.1): an item is an emoji,
// or [base, light, medium-light, medium, medium-dark, dark] when it takes a skin tone. The picker's kaomoji
// mode shows packs/emoji/kaomoji.data: categories of text faces.

import type { Effect } from './keyboard.js';
import type { PackName } from './names.js';

export type EmojiItem = string | readonly string[];
export interface EmojiGroup { id: string; name: string; items: EmojiItem[] }
export interface EmojiData { groups: EmojiGroup[] }

export const TONES = ['', 'light', 'medium-light', 'medium', 'medium-dark', 'dark'] as const;
export type Tone = (typeof TONES)[number];
export type PickerMode = 'emoji' | 'kaomoji';
export interface EmojiState { recent: string[]; favorites: string[]; tone: Tone; kaomojiRecent: string[]; mode: PickerMode }
export const NO_EMOJI_STATE: EmojiState = { recent: [], favorites: [], tone: '', kaomojiRecent: [], mode: 'emoji' };

export interface KaomojiCategory { id: string; name: PackName; faces: string[] }
export interface KaomojiData { categories: KaomojiCategory[] }

/** A kaomoji cell is this many emoji cells wide, and Recent this many columns of them. */
export const FACE_CELLS = 2.5;
export const KAOMOJI_RECENT_COLUMNS = 2;
export const FACE_PX = 15;
export const FACE_MIN_PX = 11;

/**
 * How a face `width` px wide at FACE_PX is drawn in `room` px: as it is when it fits; else in a smaller
 * font, down to FACE_MIN_PX; and if still too wide there, squeezed horizontally (scaleX) as well.
 */
export const fitFace = (width: number, room: number): { font: number; scaleX: number } => {
  if (!(width > room) || room <= 0) return { font: FACE_PX, scaleX: 1 };
  const font = FACE_PX * room / width;
  return font >= FACE_MIN_PX ? { font, scaleX: 1 } : { font: FACE_MIN_PX, scaleX: room / (width * FACE_MIN_PX / FACE_PX) };
};

/** Recent fills a fixed block; Favorites caps at the sidecar's limit. */
export const MAX_FAVORITES = 40;

export const baseOf = (item: EmojiItem): string => (typeof item === 'string' ? item : item[0]!);

/** Every base emoji that takes a skin tone, with its variants. */
export const toneTable = (data: EmojiData): Map<string, readonly string[]> =>
  new Map(data.groups.flatMap((g) => g.items.filter((i): i is readonly string[] => typeof i !== 'string').map((i) => [i[0]!, i])));

/** The emoji as typed: with the chosen skin tone where it takes one. */
export const withTone = (base: string, tone: Tone, tones: ReadonlyMap<string, readonly string[]>): string =>
  tones.get(base)?.[TONES.indexOf(tone)] ?? base;

/**
 * Recent after using an emoji: it moves to the front, unless it was picked from Recent itself, which
 * keeps its place so Recent never shifts under the laser.
 */
export const useRecent = (recent: readonly string[], base: string, fromRecent: boolean, max: number): string[] =>
  (fromRecent && recent.includes(base) ? [...recent] : [base, ...recent.filter((e) => e !== base)].slice(0, max));

/** Favorites with `base` placed at `index` (moved if already there); a full list takes no new ones. */
export const placeFavorite = (favorites: readonly string[], base: string, index: number): string[] => {
  const without = favorites.filter((e) => e !== base);
  if (without.length === favorites.length && favorites.length >= MAX_FAVORITES) return [...favorites];
  const at = Math.max(0, Math.min(index > favorites.indexOf(base) && favorites.includes(base) ? index - 1 : index, without.length));
  return [...without.slice(0, at), base, ...without.slice(at)];
};

export const removeFavorite = (favorites: readonly string[], base: string): string[] => favorites.filter((e) => e !== base);

export type SteamItemKind = 'emoticon' | 'sticker' | 'effect';
export interface SteamItem { kind: SteamItemKind; name: string }

/** A Steam item as kept in Recent and Favorites, next to emoji: "steam:<kind>:<name>". */
export const steamKey = (item: SteamItem): string => `steam:${item.kind}:${item.name}`;
export const steamFromKey = (key: string): SteamItem | null => {
  const m = /^steam:(emoticon|sticker|effect):(.+)$/s.exec(key);
  return m ? { kind: m[1] as SteamItemKind, name: m[2]! } : null;
};

/** What Steam's own keyboard types for its items: emoticons as text, stickers and effects as chat commands. */
export const steamItemEffects = (item: SteamItem): Effect[] =>
  item.kind === 'emoticon'
    ? [{ kind: 'text', text: `:${item.name}:` }]
    : [{ kind: 'text', text: `/${item.kind === 'sticker' ? 'sticker' : 'roomeffect'} ${item.name}` }, { kind: 'key', key: 'Enter' }];
