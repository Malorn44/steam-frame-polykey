// The composers a keyboard's "composer" names, the one list of them: packs/pack.schema.json's enum is
// checked against it (tests/core/composers.test.ts). direct has none: its keys type at once.

import type { KeyboardDef } from '../catalog.js';
import type { Composer } from './composer.js';
import { hangul } from './hangul.js';
import { kana } from './kana.js';
import { romaji } from './romaji.js';

export const COMPOSERS = {
  direct: null,
  kana,
  romaji,
  hangul,
} as const satisfies Record<string, Composer<unknown> | null>;

export type ComposerId = keyof typeof COMPOSERS;

/** The keyboard's composer: null when its keys type at once (direct, or a composer this build does not have). */
export const composerOf = (keyboard: KeyboardDef | undefined): Composer<unknown> | null =>
  (keyboard?.composer && Object.hasOwn(COMPOSERS, keyboard.composer) ? COMPOSERS[keyboard.composer] : null);
