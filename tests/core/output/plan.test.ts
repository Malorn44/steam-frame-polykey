import { describe, expect, it } from 'vitest';
import { BUFFERED_GAP_MS, KEYMAP_SETTLE_MS, chooseDelivery, swapsKeymap, graphemes, planCalls } from '../../../src/core/output/plan.js';

describe('graphemes', () => {
  it('keeps combined characters together', () => {
    expect(graphemes('が👍🏽a')).toEqual(['が', '👍🏽', 'a']);
  });
});

describe('planCalls', () => {
  it('run: non-ASCII runs as one call, ASCII one per call', () => {
    expect(planCalls([{ text: 'テスト' }], 'run')).toEqual(['テスト']);
    expect(planCalls([{ text: 'hi漢字!' }], 'run')).toEqual(['h', 'i', '漢字', '!']);
  });

  it('chars: one grapheme per call', () => {
    expect(planCalls([{ text: 'テスト' }], 'chars')).toEqual(['テ', 'ス', 'ト']);
  });

  it('passes key names through unchanged and keeps order', () => {
    expect(planCalls([{ text: 'a' }, { key: 'Backspace' }, { text: 'あ' }], 'run')).toEqual(['a', 'Backspace', 'あ']);
  });

  it('plans nothing for empty text', () => {
    expect(planCalls([{ text: '' }], 'chars')).toEqual([]);
  });
});

describe('chooseDelivery', () => {
  it('auto follows the mode: runs in minimal, characters with a gap in buffered', () => {
    expect(chooseDelivery('minimal', 'auto')).toEqual({ policy: 'run', gapMs: 0, settleMs: KEYMAP_SETTLE_MS });
    expect(chooseDelivery('buffered', 'auto')).toEqual({ policy: 'chars', gapMs: BUFFERED_GAP_MS, settleMs: 0 });
  });

  it('auto with an unknown mode takes the safe choice', () => {
    expect(chooseDelivery('unknown', 'auto')).toEqual({ policy: 'chars', gapMs: BUFFERED_GAP_MS, settleMs: 0 });
  });

  it('an explicit setting wins over the mode', () => {
    expect(chooseDelivery('buffered', 'run').policy).toBe('run');
    expect(chooseDelivery('minimal', 'chars')).toEqual({ policy: 'chars', gapMs: 0, settleMs: KEYMAP_SETTLE_MS });
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
