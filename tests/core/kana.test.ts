import { describe, expect, it } from 'vitest';
import type { FlickKey, KeyDef } from '../../src/core/catalog.js';
import { NO_IME, composing, pressIme, reading, type Ime } from '../../src/core/composers/kana.js';
import { flickDirection, modifyTable } from '../../src/core/kana.js';
import { inForm, toHalfwidth } from '../../src/core/forms.js';
import { optionsFor } from '../../src/core/options.js';

const ta: FlickKey = { type: 'flick', flick: ['た', 'ち', 'つ', 'て', 'と'], cycle: ['た', 'ち', 'つ', 'て', 'と', 'っ'] };
const ha: FlickKey = { type: 'flick', flick: ['は', 'ひ', 'ふ', 'へ', 'ほ'] };
const modify = modifyTable(['はばぱ', 'つっづ']);
const action = (a: 'modify' | 'undo'): KeyDef => ({ type: 'action', action: a });
const named = (key: 'ArrowRight' | 'ArrowLeft' | 'Backspace' | 'Enter'): KeyDef => ({ type: 'key', key });

/** Press keys in turn: the reading left in the buffer, and what was sent to the app. */
const run = (presses: [KeyDef, string?][], tapCycle: boolean): { buffer: string; sent: string } => {
  let ime: Ime = NO_IME;
  let sent = '';
  for (const [key, flicked] of presses) {
    const result = pressIme(ime, key, flicked === undefined ? {} : { flicked }, { tapCycle }, { modify });
    if (!result) {
      sent += `<${(key as { key?: string }).key ?? '?'}>`;
      continue;
    }
    ime = result.state;
    for (const effect of result.effects) sent += effect.kind === 'text' ? effect.text : '<undo>';
  }
  return { buffer: reading(ime), sent };
};

describe('flick direction', () => {
  it('is a tap below the threshold, else the nearest axis', () => {
    expect(flickDirection(5, 5)).toBe('tap');
    expect(flickDirection(-40, 8)).toBe('left');
    expect(flickDirection(6, -40)).toBe('up');
    expect(flickDirection(40, -20)).toBe('right');
    expect(flickDirection(0, 30)).toBe('down');
  });
});

describe('reading buffer', () => {
  it('kana wait in the buffer; 確定 (Enter) sends them', () => {
    expect(run([[ta, 'つ'], [ha, 'ほ']], false)).toEqual({ buffer: 'つほ', sent: '' });
    expect(run([[ta, 'つ'], [ha, 'ほ'], [named('Enter')]], false)).toEqual({ buffer: '', sent: 'つほ' });
  });

  it('tapping the same key again adds it again (the default)', () => {
    expect(run([[ta], [ta]], false).buffer).toBe('たた');
  });

  it('with tapCycle, tapping again goes through its cycle; → ends it and stays in the buffer', () => {
    expect(run([[ta], [ta], [ta]], true).buffer).toBe('つ');
    expect(run([[ta], [ta], [named('ArrowRight')], [ta]], true).buffer).toBe('ちた');
    expect(run([[ta], [ta], [ta], [ta], [ta], [ta], [ta]], true).buffer).toBe('た'); // past っ it wraps
    expect(run([[ta], [ha], [ha]], true).buffer).toBe('たひ'); // another key starts its own cycle
  });

  it('↶ steps back through the cycle; with an empty buffer it undoes in the app', () => {
    expect(run([[ta], [ta], [ta], [action('undo')]], true).buffer).toBe('ち');
    expect(run([[action('undo')]], false).sent).toBe('<undo>');
  });

  it('゛゜小 changes the kana before the caret; ⌫ and ← → edit the buffer', () => {
    expect(run([[ha], [action('modify')], [action('modify')]], false).buffer).toBe('ぱ');
    expect(run([[ta, 'つ'], [action('modify')]], false).buffer).toBe('っ');
    expect(run([[ha], [ta], [named('ArrowLeft')], [action('modify')]], false).buffer).toBe('ばた');
    expect(run([[ha], [ta], [named('Backspace')]], false).buffer).toBe('は');
    expect(composing(NO_IME)).toBe(false);
    expect(run([[named('ArrowRight')]], false).sent).toBe('<ArrowRight>'); // nothing typed: → moves the cursor
  });
});

describe('keyboard options', () => {
  const keyboard = { id: 'ja/12key', name: '12', layout: 'ja/flick', options: { tapCycle: false } };
  it('take the keyboard default, then the user choice, and only options the keyboard has', () => {
    expect(optionsFor(keyboard, undefined).tapCycle).toBe(false);
    expect(optionsFor(keyboard, { tapCycle: true }).tapCycle).toBe(true);
    expect(optionsFor({ ...keyboard, options: {} }, { tapCycle: true }).tapCycle).toBe(false);
  });
});

describe('reading forms', () => {
  it('gives katakana and half-width katakana, voiced marks split off', () => {
    expect(inForm('ぐりーん', 'katakana')).toBe('グリーン');
    expect(toHalfwidth('ぱゔぁ、「ゃ」。')).toBe('ﾊﾟｳﾞｧ､｢ｬ｣｡');
    expect(toHalfwidth('ヶ')).toBe('ヶ'); // no half-width form
  });

  it('symbols typed in kana mode wait in the reading too (?123, the punctuation key)', () => {
    const at: KeyDef = { type: 'char', char: '@' };
    const punct: FlickKey = { type: 'flick', flick: ['、', '。', '？', '！', '…'] };
    let ime = pressIme(NO_IME, ha, {}, { tapCycle: false }, { modify })!.state;
    const typed = pressIme(ime, at, { typed: '@' }, { tapCycle: false }, { modify })!;
    expect([reading(typed.state), typed.effects]).toEqual(['は@', []]);
    ime = pressIme(typed.state, punct, { flicked: '？' }, { tapCycle: false }, { modify })!.state;
    expect(reading(ime)).toBe('は@？');
  });

  it('while converting, 確定 confirms the focused segment and moves on; it sends after the last', () => {
    const enter = (ime: Ime) => pressIme(ime, named('Enter'), {}, { tapCycle: false }, { modify })!;
    const converting: Ime = { ...NO_IME, chars: Array.from('きょうははれ'), caret: 6,
      segments: [{ reading: 'きょうは', candidates: ['今日は'], index: 0 }, { reading: 'はれ', candidates: ['晴れ', '張れ'], index: 1 }], focus: 0 };
    const first = enter(converting);
    expect([first.state.focus, first.effects]).toEqual([1, []]); // nothing sent yet
    const last = enter(first.state);
    expect(last.effects).toEqual([{ kind: 'text', text: '今日は張れ' }]); // each segment as picked
    expect(last.state).toEqual(NO_IME);
  });

  it('かな cycles the reading; editing goes back to ひらがな; while converting it returns to カタカナ', () => {
    const kana: KeyDef = { type: 'action', action: 'kana' };
    let ime = pressIme(NO_IME, ha, {}, { tapCycle: false }, { modify })!.state;
    ime = pressIme(ime, kana, {}, { tapCycle: false }, { modify })!.state;
    expect(ime.form).toBe('katakana');
    ime = pressIme(ime, kana, {}, { tapCycle: false }, { modify })!.state;
    expect(ime.form).toBe('halfwidth');
    expect(pressIme(ime, named('Enter'), {}, { tapCycle: false }, { modify })!.effects).toEqual([{ kind: 'text', text: 'ﾊ' }]);
    expect(pressIme(ime, ta, {}, { tapCycle: false }, { modify })!.state.form).toBe('hiragana');
    const converting: Ime = { ...ime, form: 'hiragana', segments: [{ reading: 'は', candidates: ['葉'], index: 0 }] };
    const back = pressIme(converting, kana, {}, { tapCycle: false }, { modify })!;
    expect([back.state.segments, back.state.form]).toEqual([null, 'katakana']);
    expect(pressIme(NO_IME, kana, {}, { tapCycle: false }, { modify })).toEqual({ state: NO_IME, effects: [] });
  });
});
