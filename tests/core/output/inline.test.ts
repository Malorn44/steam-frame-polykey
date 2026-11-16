import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { KeyDef, TableDef } from '../../../src/core/catalog.js';
import type { ComposerContext } from '../../../src/core/composers/composer.js';
import { NO_SYLLABLE, hangul2Set } from '../../../src/core/composers/hangul.js';
import type { Effect } from '../../../src/core/keyboard.js';
import { planInline, retype, retypesInField } from '../../../src/core/output/inline.js';
import { graphemes } from '../../../src/core/output/plan.js';
import { optionsFor } from '../../../src/core/options.js';

const BS: Effect = { kind: 'key', key: 'Backspace' };
const text = (t: string): Effect => ({ kind: 'text', text: t });

describe('planInline', () => {
  it('types what is new, and deletes only the end of the tail that changed', () => {
    expect(planInline('', '', 'ㅎ')).toEqual({ erase: 0, text: 'ㅎ' }); // a composition starts
    expect(planInline('ㅎ', '', '하')).toEqual({ erase: 1, text: '하' });
    expect(planInline('하', '', '한')).toEqual({ erase: 1, text: '한' });
    expect(planInline('한', '한', 'ㄱ')).toEqual({ erase: 0, text: 'ㄱ' }); // 한 stays, ㄱ starts the next
    expect(planInline('한', '한', '')).toEqual({ erase: 0, text: '' }); // Space: 한 is already there
  });

  it('a vowel after a final takes it into the next syllable: the syllable is typed again without it', () => {
    expect(planInline('한', '하', '나')).toEqual({ erase: 1, text: '하나' });
    expect(planInline('닭', '달', '가')).toEqual({ erase: 1, text: '달가' });
  });

  it('⌫ inside a syllable types the shorter one, or only deletes once nothing is left', () => {
    expect(planInline('괜', '', '괘')).toEqual({ erase: 1, text: '괘' }); // the final off, then ㅙ splits next
    expect(planInline('괘', '', '고')).toEqual({ erase: 1, text: '고' });
    expect(planInline('ㄷ', '', '')).toEqual({ erase: 1, text: '' });
  });

  it('compares characters as they are seen (graphemes), so a longer tail keeps its common start', () => {
    expect(planInline('かな', '', 'かなが')).toEqual({ erase: 0, text: 'が' });
    expect(planInline('かんじ', '漢字', '')).toEqual({ erase: 3, text: '漢字' });
    expect(planInline('e', '', 'é')).toEqual({ erase: 1, text: 'é' }); // é as e + accent is one character
  });
});

describe('retype', () => {
  it('compares what the composer sends first with the tail, and makes what it composes the new tail', () => {
    expect(retype('하', [], '한')).toEqual({ effects: [BS, text('한')], tail: '한' });
    expect(retype('한', [text('한')], 'ㄱ')).toEqual({ effects: [text('ㄱ')], tail: 'ㄱ' });
    expect(retype('한', [text('하')], '나')).toEqual({ effects: [BS, text('하나')], tail: '나' });
    expect(retype('한', [text('한')], '')).toEqual({ effects: [], tail: '' });
  });

  it('a key the composer sends goes once the tail is settled; what it composes is typed after it', () => {
    expect(retype('ab', [text('ab'), { kind: 'key', key: 'Enter' }], 'c')).toEqual({
      effects: [{ kind: 'key', key: 'Enter' }, text('c')], tail: 'c',
    });
    expect(retype('ab', [text('a'), { kind: 'key', key: 'Tab' }, text('!')], '')).toEqual({
      effects: [BS, { kind: 'key', key: 'Tab' }, text('!')], tail: '',
    });
  });

  it('while a conversion shows in the bar the field keeps the reading; what it sends replaces it', () => {
    expect(retype('かんじ', [], null)).toEqual({ effects: [], tail: 'かんじ' });
    expect(retype('かんじ', [text('漢字')], null)).toEqual({ effects: [BS, BS, BS, text('漢字')], tail: '' });
  });
});

describe('Korean typed into a field by retyping', () => {
  const def = JSON.parse(readFileSync('packs/ko/hangul.json', 'utf8')) as TableDef;
  const ctx: ComposerContext = { options: optionsFor(undefined, undefined), table: def, layout: undefined };
  const BACKSPACE: KeyDef = { type: 'key', key: 'Backspace' };
  /** A field: text goes in at its end, a Backspace takes its last character. */
  const into = (field: string, effects: readonly Effect[]): string => effects.reduce((f, e) =>
    (e.kind === 'text' ? f + e.text : e.kind === 'key' && e.key === 'Backspace' ? graphemes(f).slice(0, -1).join('') : f), field);
  /** Each press, as the bar sends it (⌫ for Backspace; Space flushes): the field after it, and the Backspaces sent. */
  const typeKeys = (keys: string, field = '') => {
    let s = NO_SYLLABLE;
    let tail = '';
    let erased = 0;
    const steps: string[] = [];
    for (const ch of Array.from(keys)) {
      const result = ch === ' ' ? hangul2Set.flush(s, ctx)
        : ch === '⌫' ? hangul2Set.press(s, BACKSPACE, {}, ctx) : hangul2Set.press(s, { type: 'char', char: ch }, { typed: ch }, ctx);
      if (!result) throw new Error(`${ch} not for the composer`);
      s = result.state;
      const shown = hangul2Set.show(s, ctx).preedit;
      const step = retype(tail, result.effects, 'before' in shown ? shown.before + shown.after : null);
      tail = step.tail;
      erased += step.effects.filter((e) => e.kind === 'key').length;
      field = into(field, step.effects);
      steps.push(field);
    }
    return { steps, field, erased, tail };
  };

  it('each jamo shows in the field as the syllable it makes', () => {
    expect(typeKeys('ㅎㅏㄴㄱㅡㄹ').steps).toEqual(['ㅎ', '하', '한', '한ㄱ', '한그', '한글']);
    expect(typeKeys('ㅎㅏㄴㅏ').steps).toEqual(['ㅎ', '하', '한', '하나']); // the final moves on
    expect(typeKeys('ㄷㅏㄹㄱㅏ').steps).toEqual(['ㄷ', '다', '달', '닭', '달가']);
    expect(typeKeys('ㄱㅗㅐㄴㅊㅏㄶㅇㅏ').field).toBe('괜찮아');
  });

  it('⌫ takes jamo off in the field, compounds one part at a time, and only ever deletes what it typed', () => {
    expect(typeKeys('ㄱㅗㅐㄴ⌫⌫⌫⌫', '책 ').steps).toEqual(['책 ㄱ', '책 고', '책 괘', '책 괜', '책 괘', '책 고', '책 ㄱ', '책 ']);
    const { field, erased, tail } = typeKeys('ㅇㅓㅂㅅ⌫⌫⌫⌫', 'mine');
    expect([field, tail]).toEqual(['mine', '']);
    expect(erased).toBe(7); // 어 → 업 → 없 each typed again, then the way back: never more than the syllable
  });

  it('Space leaves the syllable where it is, sending nothing more', () => {
    const { field, tail } = typeKeys('ㅎㅏㄴ ');
    expect([field, tail]).toEqual(['한', '']);
  });
});

describe('retypesInField', () => {
  it('retypes in Steam and in games, keeps the bar in Desktop Mode and when streaming', () => {
    expect(retypesInField('steam-ui', undefined)).toBe(true);
    expect(retypesInField('local-app', false)).toBe(true); // a game, or an app on gamescope
    expect(retypesInField('local-app', true)).toBe(false); // Desktop Mode has the focus
    expect(retypesInField('local-app', undefined)).toBe(false); // not known yet
    expect(retypesInField('streamed', false)).toBe(false);
    expect(retypesInField('unknown', false)).toBe(false);
  });
});
