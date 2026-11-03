// Per-keyboard choices. A keyboard pack lists the options it has with its defaults; the user's choices
// (settings.json keyboardOptions, by keyboard id) override them. The settings page shows each option
// the current keyboard has.

import type { KeyboardDef, KeyboardOptions } from './catalog.js';

export type OptionName = keyof KeyboardOptions;

export const OPTIONS: Record<OptionName, { name: string; off: string; on: string }> = {
  tapCycle: { name: 'Same key again', off: 'Types it again', on: 'Next kana (→ moves on)' },
  candidatesLeft: { name: 'Candidates', off: 'On top', on: 'On the left' },
  flickHints: { name: 'Flick hints', off: 'Off', on: 'On' },
};

/** The keyboard's options with the user's choices applied (only options the keyboard has). */
export const optionsFor = (keyboard: KeyboardDef | undefined, saved: KeyboardOptions | undefined): Required<KeyboardOptions> => {
  const own = keyboard?.options ?? {};
  const pick = (name: OptionName): boolean =>
    name in own ? (typeof saved?.[name] === 'boolean' ? saved[name]! : own[name]!) : false;
  return { tapCycle: pick('tapCycle'), candidatesLeft: pick('candidatesLeft'), flickHints: pick('flickHints') };
};

/** The options a keyboard offers, in a stable order. */
export const offered = (keyboard: KeyboardDef | undefined): OptionName[] =>
  (Object.keys(OPTIONS) as OptionName[]).filter((name) => name in (keyboard?.options ?? {}));
