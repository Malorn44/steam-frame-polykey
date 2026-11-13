import { describe, expect, it } from 'vitest';
import type { KeyboardDef } from '../../src/core/catalog.js';
import {
  accuracyGrade, dictationLanguage, dictationLanguages, gradeFor, joinPhrase, micDownload, modelFor, spaceAfter, speedBars, spacedText,
  type SpeechCatalog, type SpeechModel, type SpeechStatus,
} from '../../src/core/dictation.js';
import { NO_IME, insertText, reading } from '../../src/core/composers/kana.js';

const keyboard = (language?: string) => ({ id: 'x/y', name: 'Y', layout: 'x/l', ...(language ? { language } : {}) }) as KeyboardDef;

describe('dictation', () => {
  it('dictates in the keyboard\'s language, English in 英数 mode', () => {
    expect(dictationLanguage(keyboard('ja'), false)).toBe('ja');
    expect(dictationLanguage(keyboard('ja'), true)).toBe('en');
    expect(dictationLanguage(keyboard('en-US'), false)).toBe('en');
    expect(dictationLanguage(keyboard(), false)).toBe('en');
    expect(dictationLanguage(keyboard('und;x'), false)).toBe('en');
    expect(dictationLanguages([keyboard('ja'), keyboard('en-US'), keyboard('ja-JP'), keyboard(), keyboard('und;x')], () => undefined)).toEqual(['en', 'ja']);
  });

  it('spaces a phrase like typed words, except where words are not spaced', () => {
    expect(spacedText('Hello world.', 'en', false)).toBe('Hello world. ');
    expect(spacedText('Hello world.', 'en', true)).toBe(' Hello world. ');
    expect(spacedText('今日は晴れ', 'ja', true)).toBe('今日は晴れ');
  });

  it('puts dictated text into the reading at the caret, if it fits and nothing is being converted', () => {
    const ime = { ...NO_IME, chars: ['あ', 'い'], caret: 1 };
    const next = insertText(ime, '今日')!;
    expect(reading(next)).toBe('あ今日い');
    expect(next.caret).toBe(3);
    expect(insertText({ ...ime, segments: [] }, '今日')).toBeNull();
    expect(insertText(ime, 'あ'.repeat(63))).toBeNull();
    expect(insertText(ime, '')).toBeNull();
  });
});

describe('dictation models', () => {
  const m = (id: string, languages: string[], cpuRtf = 10, error: Record<string, number> = {}): SpeechModel =>
    ({ id, name: id, languages, size: 1, licence: 'MIT', attribution: '', credit: '', ramMB: 1, notes: '', handy: { cpuRtf, error } });
  const catalog: SpeechCatalog = { engine: { version: '0.4.1', attribution: '', size: 1 },
    models: [m('en-model', ['en']), m('ja-model', ['ja', 'zh']), m('any-model', ['*'])] };
  const status = (ready: string[], choices: Record<string, string> = {}, extra: Partial<SpeechStatus> = {}): SpeechStatus => ({
    rev: 1, engine: { state: 'ready' }, choices,
    models: Object.fromEntries(catalog.models.map((x) => [x.id, ready.includes(x.id) ? { state: 'ready' } : { state: 'missing' }])),
    ...extra,
  });
  const use = (language: string, s: SpeechStatus) => modelFor(catalog, s, language)?.id;

  it('picks as the sidecar does: chosen for the language, else downloaded for it, else downloaded for any', () => {
    const all = ['en-model', 'ja-model', 'any-model'];
    expect(use('en', status(all))).toBe('en-model');
    expect(use('zh', status(all))).toBe('ja-model');
    expect(use('de', status(all))).toBe('any-model');
    expect(use('en', status(all, { en: 'any-model' }))).toBe('any-model');
    expect(use('ja', status(all, { ja: 'en-model' }))).toBe('ja-model'); // a choice that does not serve it
    expect(use('en', status(['ja-model'], { en: 'en-model' }))).toBeUndefined(); // chosen, not downloaded
  });

  it('the mic shows a download only while what it needs is coming', () => {
    const coming = (s: SpeechStatus) => micDownload(catalog, s, 'ja');
    expect(coming(status([], {}, { engine: { state: 'downloading', done: 1, total: 4 } }))).toBe(0.25);
    const ja = { 'ja-model': { state: 'downloading' as const, done: 1, total: 2 } };
    expect(coming(status([], {}, { models: { ...status([]).models, ...ja } }))).toBe(0.5);
    expect(coming(status(['any-model'], {}, { models: { ...status(['any-model']).models, ...ja } }))).toBeNull(); // any-model serves ja meanwhile
    expect(coming(status([]))).toBeNull();
    expect(micDownload(null, null, 'ja')).toBeNull();
  });

  it('rates as Handy does: speed bars from the wait after 30 s, letter grades from the error', () => {
    const bars = (rtf: number) => speedBars(m('a', ['en'], rtf));
    expect([bars(50), bars(14.3), bars(5.9), bars(2), bars(1)]).toEqual([4, 3, 2, 1, 0]); // 0.6, 2.1, 5.1, 15, 30 s
    // A+ below 5/∛4 ≈ 3.15 %, A below 5/∛2 ≈ 3.97 %, A− below 5 %; likewise for B (10 %) and C (20 %).
    expect([2, 3.5, 4.1, 6, 7.7, 9, 12, 13, 17, 25, 31].map(accuracyGrade)).toEqual(
      ['A+', 'A', 'A−', 'B+', 'B', 'B−', 'C+', 'C', 'C−', 'D', 'F']);
    expect(accuracyGrade(undefined)).toBe('');
    const whisper = m('w', ['*'], 6, { en: 6.5, ja: 12.8 });
    expect([gradeFor(whisper, 'ja'), gradeFor(whisper, 'en'), gradeFor(whisper, 'de')]).toEqual(['C', 'B', '']);
  });
});

describe('joining dictated phrases', () => {
  it('a space between words in spaced scripts, none with nothing before', () => {
    expect(joinPhrase('Hello world.', ' How are you? ')).toBe(' How are you?');
    expect(joinPhrase('', 'Hello')).toBe('Hello');
    expect(joinPhrase('안녕하세요', '반갑습니다')).toBe(' 반갑습니다'); // Korean spaces its words
    expect(joinPhrase('Привет', 'мир')).toBe(' мир');
  });

  it('no space next to scripts written without spaces', () => {
    expect(joinPhrase('今日は晴れ', 'です')).toBe('です');
    expect(joinPhrase('Hello', '今日は')).toBe('今日は');
    expect(joinPhrase('カタカナー', 'ok')).toBe('ok'); // the prolonged sound mark
    expect(joinPhrase('ｶﾀｶﾅ', 'ok')).toBe('ok'); // halfwidth katakana
    expect(joinPhrase('𠀋', 'ok')).toBe('ok'); // an extension B ideograph (a surrogate pair)
    expect(joinPhrase('ok', '豈')).toBe('豈'); // a compatibility ideograph
    expect(joinPhrase('Fine。', 'Next')).toBe('Next');
    expect(joinPhrase('ＡＢＣ', 'x')).toBe('x'); // fullwidth forms
    expect(joinPhrase('สวัสดี', 'ครับ')).toBe('ครับ'); // Thai
    expect(joinPhrase('ok', 'ລາວ')).toBe('ລາວ'); // Lao
    expect(joinPhrase('ok', 'ខ្មែរ')).toBe('ខ្មែរ'); // Khmer
    expect(joinPhrase('ok', 'မြန်မာ')).toBe('မြန်မာ'); // Myanmar
    expect(joinPhrase('ok', 'བོད')).toBe('བོད'); // Tibetan
  });

  it('no space before closing or after opening punctuation or whitespace', () => {
    expect(joinPhrase('Wait', '. Then')).toBe('. Then');
    expect(joinPhrase('Wait', '...')).toBe('...');
    expect(joinPhrase('Wait', '!')).toBe('!');
    expect(joinPhrase('Wait', ')')).toBe(')');
    expect(joinPhrase('Wait', '、ok')).toBe('、ok');
    expect(joinPhrase('see (', 'this')).toBe('this');
    expect(joinPhrase('「', 'this')).toBe('this');
    expect(joinPhrase('done ', 'next')).toBe('next');
    expect(joinPhrase('line\n', 'next')).toBe('next');
    expect(joinPhrase('ok', '   ')).toBe('');
  });

  it('a space after a phrase only where the next word would need one', () => {
    expect([spaceAfter('Hello.'), spaceAfter('今日は'), spaceAfter('see (')]).toEqual([true, false, false]);
  });
});
