import { describe, expect, it } from 'vitest';
import { BUFFERED_GAP_MS, KEYMAP_SETTLE, chooseDelivery, swapsKeymap, graphemes, planCalls } from '../../../src/core/output/plan.js';

describe('graphemes', () => {
  it('keeps combined characters together', () => {
    expect(graphemes('が👍🏽a')).toEqual(['が', '👍🏽', 'a']);
  });
});

describe('planCalls', () => {
  const strings = (...args: Parameters<typeof planCalls>) => planCalls(...args).map((c) => c.call);

  it('run: non-ASCII runs as one call, ASCII one per call', () => {
    expect(strings([{ text: 'テスト' }], 'run')).toEqual(['テスト']);
    expect(strings([{ text: 'hi漢字!' }], 'run')).toEqual(['h', 'i', '漢字', '!']);
  });

  it('chars: one grapheme per call', () => {
    expect(strings([{ text: 'テスト' }], 'chars')).toEqual(['テ', 'ス', 'ト']);
  });

  it('passes key names through unchanged, says which calls are keys, and keeps order', () => {
    expect(planCalls([{ text: 'a' }, { key: 'Backspace' }, { text: 'あ' }], 'run'))
      .toEqual([{ call: 'a', kind: 'text' }, { call: 'Backspace', kind: 'key' }, { call: 'あ', kind: 'text' }]);
  });

  it('plans nothing for empty text', () => {
    expect(planCalls([{ text: '' }], 'chars')).toEqual([]);
  });
});

describe('chooseDelivery', () => {
  it('auto follows the mode: runs in minimal, characters with a gap in buffered', () => {
    expect(chooseDelivery('minimal', 'auto')).toEqual({ policy: 'run', gapMs: 0, settle: KEYMAP_SETTLE });
    expect(chooseDelivery('buffered', 'auto')).toEqual({ policy: 'chars', gapMs: BUFFERED_GAP_MS, settle: null });
  });

  it('auto with an unknown mode takes the safe choice', () => {
    expect(chooseDelivery('unknown', 'auto')).toEqual({ policy: 'chars', gapMs: BUFFERED_GAP_MS, settle: null });
  });

  it('an explicit setting wins over the mode', () => {
    expect(chooseDelivery('buffered', 'run').policy).toBe('run');
    expect(chooseDelivery('minimal', 'chars')).toEqual({ policy: 'chars', gapMs: 0, settle: KEYMAP_SETTLE });
  });

  it('a call swaps the keymap when it has anything but printable ASCII; named keys do not', () => {
    expect(['ω・', 'あ', '😀', 'é', '\n'].map(swapsKeymap)).toEqual([true, true, true, true, true]);
    expect(['a', ' ', '~', '|', 'Backspace', 'Enter'].map(swapsKeymap)).toEqual([false, false, false, false, false, false]);
  });

  it('a gap override is used, and negative or invalid values are cleaned up', () => {
    expect(chooseDelivery('minimal', 'chars', 25).gapMs).toBe(25);
    expect(chooseDelivery('minimal', 'chars', -5).gapMs).toBe(0);
    expect(chooseDelivery('buffered', 'chars', Number.NaN).gapMs).toBe(BUFFERED_GAP_MS);
  });
});
