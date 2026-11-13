// Picker logic. Pure. The picker shows sets, each a picker pack (packs/emoji/emoji.json, kaomoji.json, a
// user's own): categories of items. An item is its text, or [base, light, medium-light, medium,
// medium-dark, dark] for an emoji that takes a skin tone (Unicode Emoji 15.1, packs/emoji/emoji.data).

import type { Effect } from './keyboard.js';
import type { PackName } from './names.js';

export type PickerItem = string | readonly string[];
export interface PickerCategory { id: string; name: PackName; icon?: string; items: PickerItem[] }
/**
 * A set, as its pack declares it. `cellWidth` is a cell's width in emoji cells (1 when left out); `tones`
 * offers skin tones, `steam` adds the user's Steam items and `favorites` a Favorites section.
 */
export interface PickerSet {
  id: string; name: PackName; icon: string; cellWidth?: number;
  tones?: boolean; steam?: boolean; favorites?: boolean;
  categories: PickerCategory[];
}

export const TONES = ['', 'light', 'medium-light', 'medium', 'medium-dark', 'dark'] as const;
export type Tone = (typeof TONES)[number];
/** Recent by set id, the Favorites and skin tone every set shares, and the set last shown ('' is the first). */
export interface EmojiState { recent: Record<string, string[]>; favorites: string[]; tone: Tone; set: string }
export const NO_EMOJI_STATE: EmojiState = { recent: {}, favorites: [], tone: '', set: '' };

const EMOJI_SET = 'emoji/emoji';
const KAOMOJI_SET = 'emoji/kaomoji';

/**
 * The saved state, also as it was before sets were packs: one `recent` list (the emoji set's),
 * `kaomojiRecent` (the kaomoji set's) and `mode` (which of the two was last shown).
 */
export const readState = (saved: unknown): EmojiState => {
  const was = (saved ?? {}) as Partial<Omit<EmojiState, 'recent'>> & { recent?: string[] | Record<string, string[]>; kaomojiRecent?: string[]; mode?: string };
  return {
    recent: Array.isArray(was.recent) ? { [EMOJI_SET]: was.recent, [KAOMOJI_SET]: was.kaomojiRecent ?? [] } : was.recent ?? {},
    favorites: was.favorites ?? [],
    tone: was.tone ?? '',
    set: was.set ?? (was.mode === 'kaomoji' ? KAOMOJI_SET : was.mode === 'emoji' ? EMOJI_SET : ''),
  };
};

/** The set to show: the one last shown, or the first when that is gone. */
export const setFor = (sets: readonly PickerSet[], id: string): PickerSet | undefined => sets.find((s) => s.id === id) ?? sets[0];
/** The set the mode key goes to: the one after the shown one, in pack order, round again at the end. */
export const nextSet = (sets: readonly PickerSet[], id: string): PickerSet | undefined =>
  sets[(Math.max(0, sets.findIndex((s) => s.id === id)) + 1) % sets.length];

/** Recent is as wide as six emoji cells, in whole columns of the set's own cells. */
export const recentColumns = (cellWidth: number): number => Math.max(1, Math.round(6 / cellWidth));
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

export const baseOf = (item: PickerItem): string => (typeof item === 'string' ? item : item[0]!);

/** Every base emoji that takes a skin tone, with its variants, from the sets that offer tones. */
export const toneTable = (sets: readonly PickerSet[]): Map<string, readonly string[]> =>
  new Map(sets.filter((s) => s.tones).flatMap((s) => s.categories)
    .flatMap((c) => c.items.filter((i): i is readonly string[] => typeof i !== 'string').map((i) => [i[0]!, i])));

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
