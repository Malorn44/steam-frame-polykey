import { describe, expect, it } from 'vitest';
import type { KeyDef } from '../../src/core/catalog.js';
import { NO_MODS, type Mods } from '../../src/core/keyboard.js';
import { keyLegends, type Legend, type LegendContext } from '../../src/core/legends.js';

const ctx = (over: Partial<LegendContext> = {}): LegendContext => ({ latin: false, romaji: false, hints: false, dotted: new Set(), ...over });
const mods = (over: Partial<Mods> = {}): Mods => ({ ...NO_MODS, ...over });
/** A legend's text, for short assertions (icons as icon:name). */
const t = (legend: Legend | undefined): string | undefined =>
  legend === undefined ? undefined : legend.kind === 'text' ? legend.text : legend.kind === 'icon' ? `icon:${legend.icon}` : legend.kind;
const shown = (key: KeyDef, m = mods(), c = ctx()) => {
  const { arrangement, slots } = keyLegends(key, m, c);
  return { arrangement, ...Object.fromEntries(Object.entries(slots).map(([slot, legend]) => [slot, t(legend)])) };
};

describe('keyLegends', () => {
  const one: KeyDef = { type: 'char', char: '1', shift: '!', fn: { type: 'key', key: 'F1' } };

  it('a plain key: the label in the middle; a long-press character top right', () => {
    expect(shown({ type: 'char', char: 'q' })).toEqual({ arrangement: 'plain', c: 'q' });
    expect(shown({ type: 'char', char: 'q', hint: '1' })).toEqual({ arrangement: 'plain', c: 'q', tr: '1' });
    expect(shown({ type: 'action', action: 'settings' }, mods(), ctx({ icon: 'settings' }))).toEqual({ arrangement: 'plain', c: 'icon:settings' });
  });

  it('Shift and Fn legends: tri with Fn, stack with Shift only; Shift swaps what is small', () => {
    expect(shown(one)).toEqual({ arrangement: 'tri', tl: '!', tr: 'F1', c: '1' });
    expect(shown(one, mods({ shift: 'once' }))).toEqual({ arrangement: 'tri', tl: '1', tr: 'F1', c: '!' });
    expect(shown(one, mods({ fn: 'once' }))).toEqual({ arrangement: 'plain', c: 'F1' }); // Fn on: the key is F1
    expect(shown({ type: 'char', char: ';', shift: ':' })).toEqual({ arrangement: 'stack', t: ':', c: ';' });
    const tr = keyLegends(one, mods(), ctx()).slots.tr;
    expect(tr).toMatchObject({ size: 'legend', tone: 'fn' });
  });

  it('a JIS key: Latin left, kana right; the mode side current; Fn shows only its variant', () => {
    const seven: KeyDef = { type: 'char', char: '7', shift: "'", kana: 'や', kanaShift: 'ゃ', fn: { type: 'key', key: 'F7' } };
    expect(shown(seven)).toEqual({ arrangement: 'quad', tl: "'", bl: '7', tr: 'ゃ', br: 'や' });
    const kana = keyLegends(seven, mods(), ctx()).slots;
    expect(kana.br).toMatchObject({ size: 'dual', tone: 'text' }); // や is typed now
    expect(kana.tr).toMatchObject({ size: 'legend', tone: 'legend' });
    expect(keyLegends(seven, mods({ shift: 'once' }), ctx()).slots.tr).toMatchObject({ size: 'dual' }); // ゃ now
    expect(keyLegends(seven, mods(), ctx({ latin: true })).slots.bl).toMatchObject({ size: 'dual' }); // 英数: 7
    expect(shown(seven, mods({ fn: 'once' }))).toEqual({ arrangement: 'quad', c: 'F7' });
    const a: KeyDef = { type: 'char', char: 'a', kana: 'ち' };
    expect(shown(a, mods({ shift: 'once' }), ctx({ latin: true }))).toEqual({ arrangement: 'quad', bl: 'A', br: 'ち' }); // a letter: one Latin legend
  });

  it('a JIS key typing romaji: Latin legends only, in the middle (a letter alone in the centre)', () => {
    const seven: KeyDef = { type: 'char', char: '7', shift: "'", kana: 'や', kanaShift: 'ゃ' };
    expect(shown(seven, mods(), ctx({ romaji: true }))).toEqual({ arrangement: 'quad', t: "'", b: '7' });
    expect(shown({ type: 'char', char: 'a', kana: 'ち' }, mods(), ctx({ romaji: true }))).toEqual({ arrangement: 'quad', c: 'a' });
  });

  it('flick keys: hints at the edges when on; otherwise the label, with its digit beneath', () => {
    const punct: KeyDef = { type: 'flick', flick: ['、', '。', '？', '！', '…'], hints: true };
    expect(shown(punct)).toEqual({ arrangement: 'edges', c: '、', l: '。', t: '？', r: '！', b: '…' });
    const ka: KeyDef = { type: 'flick', flick: ['か', 'き', 'く', 'け', 'こ'] };
    expect(shown(ka)).toEqual({ arrangement: 'plain', c: 'か' });
    expect(shown(ka, mods(), ctx({ hints: true }))).toMatchObject({ arrangement: 'edges', l: 'き' });
    const abc: KeyDef = { type: 'flick', flick: ['@', '-', '_', '/', '1'], label: '@-_/', sub: '1' };
    const c = keyLegends(abc, mods(), ctx()).slots.c;
    expect(c).toMatchObject({ kind: 'text', text: '@-_/', under: { text: '1', size: 'sub' } });
    expect(keyLegends(abc, mods(), ctx({ hints: true })).slots.c).toMatchObject({ text: '@' }); // hints show the rest
  });

  it('boxes the characters the layout lists, wherever they are', () => {
    const punct: KeyDef = { type: 'flick', flick: ['、', '。', '？', '！', '…'], hints: true };
    const { slots } = keyLegends(punct, mods(), ctx({ dotted: new Set(['、', '。']) }));
    expect(slots.c).toMatchObject({ boxed: true });
    expect(slots.l).toMatchObject({ boxed: true });
    expect(slots.t).toMatchObject({ boxed: false });
  });

  it('the ゛゜ key: marks over 大⇔小, unless it has its own label; the mode key: あ a, the mode bold', () => {
    const modify = keyLegends({ type: 'action', action: 'modify' }, mods(), ctx({ dotted: new Set(['゛', '゜']) })).slots.c;
    expect(modify).toMatchObject({ kind: 'marks', marks: [{ text: '゛', boxed: true }, { text: '゜', boxed: true }], under: { text: '大⇔小', size: 'hint' } });
    expect(shown({ type: 'action', action: 'modify', label: '゛゜小' })).toEqual({ arrangement: 'plain', c: '゛゜小' });
    const mode: KeyDef = { type: 'action', action: 'eisu', label: 'あ a' };
    expect(keyLegends(mode, mods(), ctx()).slots.c).toEqual({ kind: 'pair', parts: ['あ', 'a'], now: 0 });
    expect(keyLegends(mode, mods(), ctx({ latin: true })).slots.c).toMatchObject({ now: 1 });
  });

  it('a page label replaces the label only; gaps and the bottom of a two-row key show nothing', () => {
    expect(shown({ type: 'key', key: 'Enter' }, mods(), ctx({ label: '確定', icon: 'enter' }))).toEqual({ arrangement: 'plain', c: '確定' });
    expect(shown(one, mods(), ctx({ label: 'x' }))).toEqual({ arrangement: 'tri', tl: '!', tr: 'F1', c: 'x' });
    expect(shown({ type: 'gap', w: 1 })).toEqual({ arrangement: 'plain' });
    expect(shown({ type: 'key', key: 'Enter', tall: 'bottom' })).toEqual({ arrangement: 'plain' });
  });
});
