// The boot catalog built from the real bundled packs, resolved by the sidecar as it would send it.
import { execFileSync } from 'node:child_process';
import type { Boot } from '../src/core/catalog.js';
import type { PickerCategory, PickerSet } from '../src/core/emoji.js';

export const bundledBoot = (): Boot => {
  const out = execFileSync('python3', ['-m', 'polykey.packs', 'packs', 'packs/pack.schema.json'],
    { env: { ...process.env, PYTHONPATH: 'sidecar' }, encoding: 'utf8' });
  const { catalog, pickers, errors } = JSON.parse(out) as Pick<Boot, 'catalog' | 'pickers' | 'errors'>;
  return { catalog, pickers: pickers ?? [], settings: { keyboards: ['en/english', 'ja/12key', 'ja/50on', 'ja/romaji', 'ja/jis'], theme: 'themes/steam' }, errors };
};

export const EMOJI = 'emoji/emoji';
export const KAOMOJI = 'emoji/kaomoji';
/** A small emoji set, declared as the bundled one is: these categories, then the Steam items. */
export const emojiSet = (categories: PickerCategory[]): PickerSet => ({
  id: EMOJI, name: { en: 'Emoji', ja: '絵文字' }, key: { icon: 'emoji' }, cells: 'emoji', cellWidth: 1,
  recent: true, recentBin: true, favorites: true, tones: true,
  categories: [
    ...categories,
    { id: 'steam-emoticon', name: 'Steam emoticons', icon: 'emoticons', label: 'Steam', apart: true, steam: 'emoticon', items: [] },
    { id: 'steam-sticker', name: 'Steam stickers', icon: 'stickers', apart: true, steam: 'sticker', items: [] },
    { id: 'steam-effect', name: 'Steam room effects', icon: 'effects', apart: true, steam: 'effect', items: [] },
  ],
});
/** A small kaomoji set, declared as the bundled one is: every category labelled. */
export const kaomojiSet = (categories: PickerCategory[]): PickerSet => ({
  id: KAOMOJI, name: { en: 'Kaomoji', ja: '顔文字' }, key: { label: ':-)' }, cells: 'text', cellWidth: 2.5, recent: true,
  categories: categories.map((c) => ({ label: true as const, ...c })),
});
