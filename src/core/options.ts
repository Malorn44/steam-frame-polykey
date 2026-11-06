// Per-keyboard choices. A keyboard pack lists the options it has with its defaults; the user's choices
// (settings.json keyboardOptions, by keyboard id) override them. The settings page shows each option
// the current keyboard has.

import type { KeyboardDef, KeyboardOptions } from './catalog.js';

export type OptionName = keyof KeyboardOptions;

/**
 * How the settings page shows an option: two named choices, or (toggle) a switch beside a statement,
 * worded as Gboard's settings are; invert: the switch is on when the option is off.
 */
export interface OptionInfo {
  name: string;
  off: string;
  on: string;
  toggle?: boolean;
  invert?: boolean;
}

/** In the order the settings page lists them. */
export const OPTIONS: Record<OptionName, OptionInfo> = {
  qwertyLatin: { name: '英字入力はQWERTY', off: 'Flick (abc)', on: 'QWERTY', toggle: true },
  // Gboard's フリックのみ: on, tapping a key again types it again; off, it steps to the next kana.
  tapCycle: { name: 'フリックのみ', off: 'Types it again', on: 'Next kana (→ moves on)', toggle: true, invert: true },
  flickHints: { name: 'フリックガイドを表示', off: 'Off', on: 'On', toggle: true },
  candidatesLeft: { name: '候補を左に表示', off: 'On top', on: 'On the left', toggle: true },
  romajiInput: { name: 'ローマ字入力', off: 'かな', on: 'ローマ字', toggle: true },
  swipe: { name: 'Swipe typing', off: 'Off', on: 'On', toggle: true },
  // Where dictated text goes on a keyboard with a reading: into it, for its candidates, or typed at once.
  dictationCommit: { name: 'Dictation', off: 'Candidates', on: 'Type at once' },
};

/** A keyboard with a reading buffer (and so candidates) offers dictationCommit; packs do not list it. */
const hasReading = (keyboard: KeyboardDef | undefined): boolean =>
  keyboard?.composer === 'kana' || keyboard?.composer === 'romaji';

/** The keyboard's options with the user's choices applied (only options the keyboard has). */
export const optionsFor = (
  keyboard: KeyboardDef | undefined,
  saved: KeyboardOptions | undefined,
): Required<KeyboardOptions> => {
  const own = keyboard?.options ?? {};
  const pick = (name: OptionName): boolean =>
    name in own ? (typeof saved?.[name] === 'boolean' ? saved[name] : own[name]!) : false;
  return {
    tapCycle: pick('tapCycle'),
    candidatesLeft: pick('candidatesLeft'),
    flickHints: pick('flickHints'),
    romajiInput: pick('romajiInput'),
    qwertyLatin: pick('qwertyLatin'),
    swipe: pick('swipe'),
    dictationCommit: hasReading(keyboard) && saved?.dictationCommit === true,
  };
};

/** The options a keyboard offers, in a stable order. */
export const offered = (keyboard: KeyboardDef | undefined): OptionName[] =>
  (Object.keys(OPTIONS) as OptionName[]).filter((name) =>
    name === 'dictationCommit' ? hasReading(keyboard) : name in (keyboard?.options ?? {}),
  );

/** The word list a swipe is decoded against, while the keyboard can swipe and its swipe option is on. */
export const swipeLexicon = (
  keyboard: KeyboardDef | undefined,
  saved: KeyboardOptions | undefined,
): string | undefined =>
  keyboard?.features?.swipe && optionsFor(keyboard, saved).swipe ? keyboard.features.swipe.lexicon : undefined;
