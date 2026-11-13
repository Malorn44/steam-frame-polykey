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
/** A small emoji set, declared as the bundled one is. */
export const emojiSet = (categories: PickerCategory[]): PickerSet =>
  ({ id: EMOJI, name: { en: 'Emoji', ja: '絵文字' }, icon: 'emoji', cellWidth: 1, tones: true, steam: true, favorites: true, categories });
/** A small kaomoji set, declared as the bundled one is. */
export const kaomojiSet = (categories: PickerCategory[]): PickerSet =>
  ({ id: KAOMOJI, name: { en: 'Kaomoji', ja: '顔文字' }, icon: 'emoticons', cellWidth: 2.5, categories });
