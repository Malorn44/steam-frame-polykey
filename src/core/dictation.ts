// Dictation, the pure parts: the language a keyboard dictates in, and the text a keyboard that types
// directly sends. Dictated text is typed content: never logged.

import type { KeyboardDef } from './catalog.js';

/** The mic key: idle, listening (push to talk), the phrase being recognized, or a failure shown briefly. */
export type MicState = 'idle' | 'listening' | 'transcribing' | 'error';

/** Languages written without spaces between words. */
const UNSPACED = new Set(['ja', 'zh', 'th', 'lo', 'my', 'km']);

/** A keyboard language as dictation names it (ja-JP → ja), or undefined when it is not one. */
const languageCode = (tag: string | undefined): string | undefined => {
  const code = (tag ?? '').toLowerCase().split(/[-_]/)[0] ?? '';
  return /^[a-z]{2,3}$/.test(code) ? code : undefined;
};

/** English in a Japanese keyboard's 英数 mode; otherwise the keyboard's language. */
export const dictationLanguage = (keyboard: KeyboardDef | undefined, latin: boolean): string =>
  (latin ? 'en' : languageCode(keyboard?.language) ?? 'en');

/** The languages the keyboards dictate in, sorted (the Dictation tab lists them). */
export const dictationLanguages = (keyboards: readonly KeyboardDef[]): string[] =>
  [...new Set(keyboards.flatMap((k) => languageCode(k.language) ?? []))].sort();

/** Dictated text as typed: a space first when a word was being typed, and one after it where words are spaced. */
export const spacedText = (text: string, language: string, midWord: boolean): string =>
  (UNSPACED.has(language) ? text : `${midWord ? ' ' : ''}${text} `);

/** A model on offer (the sidecar's dictation.catalog; sidecar/polykey/speech/catalog.json). */
export interface SpeechModel {
  id: string;
  name: string;
  /** Language tags as keyboard packs write them; ANY_LANGUAGE for one that takes any (Whisper). */
  languages: string[];
  size: number;
  licence: string;
  attribution: string;
  /** The attribution, short: who made it and who converted it (the full one is `attribution`). */
  credit: string;
  ramMB: number;
  notes: string;
  /** Handy's benchmark (not measured on the Frame): times faster than real time on a laptop CPU, FLEURS error %. */
  handy: { cpuRtf?: number; error?: Record<string, number> };
}

export interface SpeechCatalog {
  engine: { version: string; attribution: string; size: number };
  models: SpeechModel[];
}

/** A download's state: in place, under way, or missing (with why the last attempt failed). */
export type FileState = { state: 'ready' } | { state: 'downloading'; done: number; total: number } | { state: 'missing'; error?: string };

export interface SpeechStatus {
  rev: number;
  engine: FileState;
  models: Record<string, FileState>;
  /** The model chosen per language (settings.json "dictationModels"). */
  choices: Record<string, string>;
}

export const ANY_LANGUAGE = '*';

/** dictation.status's reply; null when it is not one. The sidecar checks what it sends (session.py). */
export const parseStatus = (reply: Record<string, unknown>): SpeechStatus | null =>
  (reply['ok'] === true && typeof reply['rev'] === 'number' && typeof reply['engine'] === 'object'
    ? { rev: reply['rev'], engine: reply['engine'] as FileState, models: (reply['models'] ?? {}) as SpeechStatus['models'],
        choices: (reply['choices'] ?? {}) as SpeechStatus['choices'] }
    : null);

/** dictation.catalog's reply; null when it is not one (the sidecar checked catalog.json strictly). */
export const parseCatalog = (reply: Record<string, unknown>): SpeechCatalog | null =>
  (reply['ok'] === true && Array.isArray(reply['models']) ? { engine: reply['engine'], models: reply['models'] as SpeechModel[] } as SpeechCatalog : null);

export const serves = (model: SpeechModel, language: string): boolean =>
  model.languages.includes(ANY_LANGUAGE) || model.languages.includes(language);

/**
 * The model dictation uses for `language`, as the sidecar picks it (session.py, pick): the one chosen
 * for it, else a downloaded one made for it, else a downloaded one for any language (Whisper).
 */
export const modelFor = (catalog: SpeechCatalog, status: SpeechStatus, language: string): SpeechModel | undefined => {
  const ready = (m: SpeechModel | undefined): m is SpeechModel => !!m && status.models[m.id]?.state === 'ready';
  const chosen = catalog.models.find((m) => m.id === status.choices[language]);
  if (ready(chosen) && serves(chosen, language)) return chosen;
  return catalog.models.find((m) => ready(m) && m.languages.includes(language))
    ?? catalog.models.find((m) => ready(m) && m.languages.includes(ANY_LANGUAGE));
};

// Ratings as Handy shows them, from Handy's benchmark (a laptop CPU, not the Frame). The mappings are
// Handy's (MIT): speed bars from cjpais/Handy src/components/shared/SpeedBars.tsx (commit 82dfab9), the
// letter grade from @handy-computer/models 0.2.3 accuracyGrade; the code is ours.

/** The seconds a 30-second dictation may take for 4, 3, 2 and 1 bars. */
const SPEED_CUTOFFS_S = [2, 3.5, 7.5, 20];
/** Error ceilings (%) of A, B, C and D; F beyond. Each step of + or − is a factor of ∛2 in the error. */
const GRADE_CEILINGS: [string, number][] = [['A', 5], ['B', 10], ['C', 20], ['D', 30]];

/** Speed as 0–4 bars: how many cutoffs the wait after 30 s of speech, on Handy's CPU, beats. */
export const speedBars = (model: SpeechModel): number => {
  const rtf = model.handy.cpuRtf;
  return rtf ? SPEED_CUTOFFS_S.filter((cutoff) => 30 / rtf < cutoff).length : 0;
};

/** A letter grade for an error %: A+ … C−, D, F ('' when not measured). */
export const accuracyGrade = (error: number | undefined): string => {
  if (error === undefined) return '';
  const [letter, ceiling] = GRADE_CEILINGS.find(([, limit]) => error < limit) ?? ['F', Infinity];
  if (letter === 'D' || letter === 'F') return letter;
  const step = Math.cbrt(2);
  return `${letter}${error < ceiling / step ** 2 ? '+' : error < ceiling / step ? '' : '−'}`;
};

/** A model's grade for `language` ('' when Handy did not measure it there). */
export const gradeFor = (model: SpeechModel, language: string): string => accuracyGrade(model.handy.error?.[language]);

/**
 * What the mic key shows while it cannot dictate in `language` yet because something is downloading:
 * the engine's progress, or that of a model that would serve the language; null when nothing is.
 */
export const micDownload = (catalog: SpeechCatalog | null, status: SpeechStatus | null, language: string): number | null => {
  if (!status) return null;
  const share = (s: FileState): number | null => (s.state === 'downloading' ? s.done / Math.max(1, s.total) : null);
  if (status.engine.state === 'downloading') return share(status.engine);
  if (!catalog || modelFor(catalog, status, language)) return null;
  const coming = catalog.models.find((m) => serves(m, language) && status.models[m.id]?.state === 'downloading');
  return coming ? share(status.models[coming.id]!) : null;
};

/** Whether anything is downloading (the page then follows the status). */
export const downloading = (status: SpeechStatus | null): boolean =>
  !!status && [status.engine, ...Object.values(status.models)].some((s) => s.state === 'downloading');

/**
 * Scripts written without spaces between words: Hiragana, Katakana (with the prolonged sound mark and the
 * halfwidth forms), CJK ideographs (extensions and compatibility ones are Script=Han too), CJK symbols and
 * punctuation, fullwidth forms, vertical forms, Thai, Lao, Khmer, Myanmar, Tibetan. Not Hangul: Korean
 * spaces its words. (Property escapes: ES2018, and Chromium since 64.)
 */
const UNSPACED_SCRIPT = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}\u3000-\u303fー\ufe30-\ufe4f\uff00-\uff9f\uffe0-\uffef]/u;
/** Punctuation that closes or follows: never a space before it. */
const CLOSING = /[.,!?;:)\]}…‥%、。，．！？：；）］｝」』】〕〉》〗〙〛｣]/u;
/** Punctuation that opens: never a space after it. */
const OPENING = /[([{「『【〔〈《〖〘〚｢（［｛]/u;

/**
 * A recognized phrase as it joins the text before it: trimmed, with one space first unless either side
 * is in a script written without spaces, the phrase starts with closing punctuation, or the text before
 * ends with opening punctuation or whitespace. With nothing (or nothing known) before, no space.
 */
export const joinPhrase = (before: string, phrase: string): string => {
  const next = phrase.trim();
  const last = before.slice(-1);
  // The last code point, so a surrogate pair (CJK extension B and beyond) counts as one character.
  const end = /[\udc00-\udfff]/.test(last) ? before.slice(-2) : last;
  const first = String.fromCodePoint(next.codePointAt(0) ?? 32);
  if (!next || !end || /\s/u.test(end) || OPENING.test(end) || CLOSING.test(first)
    || UNSPACED_SCRIPT.test(end) || UNSPACED_SCRIPT.test(first)) return next;
  return ` ${next}`;
};

/** Whether a word typed after `text` takes a space first (joinPhrase's rule). */
export const spaceAfter = (text: string): boolean => joinPhrase(text, 'a') === ' a';
