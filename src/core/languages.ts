// A keyboard's language pack (kind language), and what keyboards take from it: their idle hint and the
// words their bar's keys show. Their letters are core/pages.ts's modeLetters, their dictation language
// core/dictation.ts's. A keyboard's own fields win. Pure.

import type { KeyboardDef, LanguageDef } from './catalog.js';

/** The language pack for the keyboard's language: that code's, else its base language's (pt-BR → pt). */
export const languageOf = (languages: Readonly<Record<string, LanguageDef>> | undefined, keyboard: KeyboardDef | undefined): LanguageDef | undefined => {
  const code = keyboard?.language;
  const own = (c: string | undefined): LanguageDef | undefined => (c && languages && Object.hasOwn(languages, c) ? languages[c] : undefined);
  return own(code) ?? own(code?.split('-')[0]);
};

/** Shown where candidates appear while there are none: the keyboard's own, else its language's. */
export const idleHint = (keyboard: KeyboardDef | undefined, language: LanguageDef | undefined): string | undefined =>
  keyboard?.strings?.idleHint ?? language?.idleHint;

/** Key labels by key id, from label names (convert) to the language's words (変換); a name it lacks leaves that key as it is. */
export const spelled = (names: Readonly<Record<string, string>>, language: LanguageDef | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(names).flatMap(([key, name]) => {
    const word = language?.labels && Object.hasOwn(language.labels, name) ? language.labels[name] : undefined;
    return word ? [[key, word]] : [];
  }));
