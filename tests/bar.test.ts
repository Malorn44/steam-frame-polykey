// The bar controller with a composer of its own (not one of polykey's): it knows nothing of Japanese.
import { describe, expect, it, vi } from 'vitest';
import { createBar, type BarKeyboard } from '../src/bar.js';
import type { BridgeReply } from '../src/bridge/client.js';
import type { KeyDef } from '../src/core/catalog.js';
import type { Composer, ComposerContext } from '../src/core/composers/composer.js';
import type { Effect } from '../src/core/keyboard.js';
import { optionsFor } from '../src/core/options.js';

/** Letters wait in capitals; Space sends them with a space; Backspace takes one off; nothing else is for it. */
const shout: Composer<string> = {
  empty: '',
  composing: (s) => s !== '',
  press: (s, key, { typed }) => {
    if (typed !== undefined && /^[a-z]$/.test(typed)) return { state: s + typed.toUpperCase(), effects: [], request: { kind: 'live' } };
    if (s && key.type === 'char' && key.char === ' ') return { state: '', effects: [{ kind: 'text', text: `${s} ` }] };
    if (s && key.type === 'key' && key.key === 'Backspace') return { state: s.slice(0, -1), effects: [] };
    return null;
  },
  flush: (s) => ({ state: '', effects: s ? [{ kind: 'text', text: s }] : [] }),
  show: (s) => ({ preedit: { before: s, after: '' }, labels: { ' ': 'send' } }),
  convert: {
    reading: (s) => s,
    converted: (s) => s,
    live: (reading, segments) => [reading, ...segments.flatMap((seg) => seg.candidates)],
    pick: (_s, text) => ({ state: '', effects: [{ kind: 'text', text }], learned: { reading: 'X', prediction: text } }),
  },
};

const ctx: ComposerContext = { options: optionsFor(undefined, undefined), table: undefined, layout: undefined };
const char = (c: string): KeyDef => ({ type: 'char', char: c });

/** A bar on a keyboard with this converter (null: none). */
const setup = (converter: string | null = 'mine') => {
  const sent: Effect[] = [];
  const calls: Record<string, unknown>[] = [];
  const answers: ((reply: BridgeReply) => void)[] = [];
  let kb: BarKeyboard | null = { composer: shout, ctx, converter: converter ?? undefined };
  const shows = vi.fn();
  const bar = createBar({
    call: (op, args = {}) => {
      calls.push({ op, ...args });
      return new Promise((resolve) => answers.push(resolve));
    },
    available: () => true,
    enqueue: (effects) => sent.push(...effects),
    show: shows,
    warn: () => {},
    keyboard: () => kb,
  });
  return { bar, sent, calls, answers, shows, switchTo: (next: BarKeyboard | null) => { kb = next; } };
};

describe('the bar controller', () => {
  it('keeps what the composer composes, sends its commits, and leaves other keys to the caller', () => {
    const { bar, sent } = setup();
    expect(bar.press(char('h'), { typed: 'h' })).toBe(true);
    expect(bar.press(char('i'), { typed: 'i' })).toBe(true);
    expect(bar.composing()).toBe(true);
    expect(bar.shown()).toEqual({ composition: { before: 'HI', after: '', candidates: ['HI'], selected: -1 }, labels: { ' ': 'send' } });
    expect(bar.composedText()).toBe('HI');
    expect(bar.press({ type: 'key', key: 'Tab' }, {})).toBe(false); // not for it
    bar.flush();
    expect(sent).toEqual([{ kind: 'text', text: 'HI' }]);
    expect(bar.composing()).toBe(false);
    expect([bar.shown(), bar.composedText()]).toEqual([null, '']);
  });

  it('asks the keyboard\'s own converter, by name, and shows its answer', async () => {
    const { bar, calls, answers } = setup('mine');
    bar.press(char('a'), { typed: 'a' });
    expect(calls).toEqual([{ op: 'convert', converter: 'mine', reading: 'A' }, { op: 'predict', converter: 'mine', reading: 'A' }]);
    answers[0]!({ id: 1, ok: true, segments: [{ reading: 'A', candidates: ['α'] }] });
    answers[1]!({ id: 2, ok: true, predictions: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(bar.shown()?.composition.candidates).toEqual(['A', 'α']);
  });

  it('drops an answer to an older request, and one that comes after the keyboard was left', async () => {
    const { bar, answers, switchTo } = setup();
    bar.press(char('a'), { typed: 'a' });
    bar.press(char('b'), { typed: 'b' });
    answers[0]!({ id: 1, ok: true, segments: [{ reading: 'A', candidates: ['old'] }] });
    answers[1]!({ id: 2, ok: true, predictions: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(bar.shown()?.composition.candidates).toEqual(['AB']);
    bar.leave();
    switchTo({ composer: shout, ctx, converter: 'mine' });
    answers[2]!({ id: 3, ok: true, segments: [{ reading: 'AB', candidates: ['late'] }] });
    answers[3]!({ id: 4, ok: true, predictions: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(bar.shown()).toBeNull();
  });

  it('without a converter nothing is asked; the composer\'s own candidates show', () => {
    const { bar, calls } = setup(null);
    bar.press(char('a'), { typed: 'a' });
    expect(calls).toEqual([]);
    expect(bar.shown()?.composition.candidates).toEqual(['A']);
  });

  it('a pick is sent, and what the composer learned from it goes to the converter', () => {
    const { bar, sent, calls } = setup();
    bar.press(char('a'), { typed: 'a' });
    bar.pick('α', 1);
    expect(sent).toEqual([{ kind: 'text', text: 'α' }]);
    expect(calls.at(-1)).toEqual({ op: 'learn', converter: 'mine', reading: 'X', prediction: 'α' });
  });

  it('leaving sends what waits; a closed field drops it; dictation without insert is sent after it', () => {
    const left = setup();
    left.bar.press(char('a'), { typed: 'a' });
    left.bar.leave();
    expect(left.sent).toEqual([{ kind: 'text', text: 'A' }]);
    const closed = setup();
    closed.bar.press(char('a'), { typed: 'a' });
    closed.bar.drop();
    expect([closed.bar.composing(), closed.sent]).toEqual([false, []]);
    const dictated = setup();
    dictated.bar.press(char('a'), { typed: 'a' });
    dictated.bar.dictate('hello');
    expect(dictated.sent).toEqual([{ kind: 'text', text: 'A' }, { kind: 'text', text: 'hello' }]);
  });

  it('a keyboard that types at once has no bar', () => {
    const { bar, switchTo } = setup();
    switchTo(null);
    expect(bar.press(char('a'), { typed: 'a' })).toBe(false);
    expect([bar.composing(), bar.shown()]).toEqual([false, null]);
  });

  it('the text being composed is what the bar shows: a converted reading is its segments', () => {
    const { bar, switchTo } = setup(null);
    const segments: Composer<string> = { ...shout, show: (s) => ({ preedit: { segments: [s, '!'], focus: 0, candidates: [], selected: 0 }, labels: {} }) };
    switchTo({ composer: segments, ctx, converter: undefined });
    bar.press(char('h'), { typed: 'h' });
    expect(bar.composedText()).toBe('H!');
  });
});
