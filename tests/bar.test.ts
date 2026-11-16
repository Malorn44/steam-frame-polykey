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
    canRetype: () => false,
    target: () => '',
    typed: () => '',
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

  it('a conversion\'s candidates keep their notes, as the composer shows them', () => {
    const { bar, switchTo } = setup(null);
    const noted: Composer<string> = {
      ...shout, show: (s) => ({ preedit: { segments: [s], focus: 0, candidates: ['α', 'β'], selected: 0, notes: ['alpha', ''] }, labels: {} }),
    };
    switchTo({ composer: noted, ctx, converter: undefined });
    bar.press(char('a'), { typed: 'a' });
    expect(bar.shown()?.composition).toEqual({ segments: ['A'], focus: 0, candidates: ['α', 'β'], selected: 0, notes: ['alpha', ''] });
  });
});

describe('composing in the text field', () => {
  /** shout, opted in; a conversion (?) shows in the bar as segments. */
  const inline: Composer<string> = {
    ...shout,
    inline: true,
    show: (s) => (s.endsWith('?')
      ? { preedit: { segments: [`<${s.slice(0, -1)}>`], focus: 0, candidates: [], selected: 0 }, labels: {} }
      : { preedit: { before: s, after: '' }, labels: {} }),
    press: (s, key, input, c) => (key.type === 'char' && key.char === '?' && s ? { state: `${s}?`, effects: [] } : shout.press(s, key, input, c)),
  };
  /** A field: text at its end, a Backspace takes its last character; the sends as they were made. */
  const setupField = (composer: Composer<unknown> = inline, start = 'mine ') => {
    let field = start;
    let retyping = true;
    let where = 'app';
    /** What the bar typed into the field, as the page tracks it when a send is queued (the word being typed). */
    let typed = '';
    const queued: { effects: readonly Effect[]; live: () => boolean }[] = [];
    const sent: Effect[][] = [];
    const shows = vi.fn();
    const bar = createBar({
      call: () => new Promise(() => {}),
      available: () => true,
      enqueue: (effects, send) => {
        for (const e of effects) typed = e.kind === 'text' ? typed + e.text : e.kind === 'key' && e.key === 'Backspace' ? typed.slice(0, -1) : '';
        queued.push({ effects, live: send?.live ?? (() => true) });
      },
      show: shows,
      warn: () => {},
      keyboard: () => ({ composer, ctx, converter: undefined }),
      canRetype: () => retyping,
      target: () => where,
      typed: () => typed,
    });
    /** Make the queued sends, as the page's queue does: a send no longer live is skipped. */
    const run = () => {
      for (const { effects, live } of queued.splice(0)) {
        if (!live()) continue;
        sent.push([...effects]);
        for (const e of effects) {
          if (e.kind === 'text') field += e.text;
          else if (e.kind === 'key' && e.key === 'Backspace') field = field.slice(0, -1);
        }
      }
      return field;
    };
    const backspaces = () => sent.flat().filter((e) => e.kind === 'key').length;
    const typeAll = (keys: string) => { for (const k of Array.from(keys)) bar.press(char(k), { typed: k }); };
    return {
      bar, run, sent, backspaces, typeAll, queued, shows,
      setRetype: (on: boolean) => { retyping = on; }, moveTo: (to: string) => { where = to; },
    };
  };
  const BS: KeyDef = { type: 'key', key: 'Backspace' };

  it('types each change into the field, deleting only what differs; the bar shows only the candidates', () => {
    const { bar, run, sent, typeAll } = setupField();
    typeAll('hi');
    expect(run()).toBe('mine HI');
    expect(sent).toEqual([[{ kind: 'text', text: 'H' }], [{ kind: 'text', text: 'I' }]]);
    expect(bar.inField()).toBe(true);
    expect(bar.shown()?.composition).toEqual({ before: '', after: '', candidates: ['HI'], selected: -1 });
    expect(bar.composedText()).toBe(''); // it is in the field, part of what was typed
    bar.press(BS, {});
    expect(run()).toBe('mine H');
    bar.press(char(' '), {}); // the composer sends 'H ': the H is already there
    expect(run()).toBe('mine H ');
    expect(sent.at(-1)).toEqual([{ kind: 'text', text: ' ' }]);
    expect([bar.inField(), bar.composing()]).toEqual([false, false]);
  });

  it('a key it does not take, leaving, or a pick replacing the word leaves what is in the field as it is', () => {
    for (const end of ['flush', 'leave', 'drop'] as const) {
      const { bar, run, backspaces, typeAll } = setupField();
      typeAll('ok');
      bar[end]();
      expect(run()).toBe('mine OK');
      expect([backspaces(), bar.inField(), bar.composing()]).toEqual([0, false, false]);
      typeAll('a');
      expect(run()).toBe('mine OKA'); // a new composition, typed after it
    }
  });

  it('when the field may have changed, its tail is forgotten without a Backspace, and sends still queued are skipped', () => {
    const { bar, run, backspaces, typeAll, queued } = setupField();
    typeAll('ab');
    expect(run()).toBe('mine AB');
    typeAll('c'); // queued, not made yet
    bar.lose();
    expect(queued).toHaveLength(1);
    expect(run()).toBe('mine AB'); // skipped: the field it was planned for may be gone
    expect([bar.inField(), bar.composing()]).toEqual([false, false]);
    expect(bar.press(BS, {})).toBe(false); // nothing composed: ⌫ is the field's own
    typeAll('d');
    expect(run()).toBe('mine ABD');
    expect(backspaces()).toBe(0);
  });

  it('typing that now goes to another target forgets the tail first, without a Backspace', () => {
    const { bar, run, backspaces, typeAll, moveTo } = setupField();
    typeAll('ab');
    run();
    moveTo('elsewhere');
    expect(bar.press(BS, {})).toBe(false); // not the composer's any more
    typeAll('c');
    expect(run()).toBe('mine ABC');
    expect(backspaces()).toBe(0);
  });

  it('once it may no longer retype, the composition stays in the field as it is and the next waits in the bar', () => {
    const { bar, run, backspaces, typeAll, setRetype } = setupField();
    typeAll('ab');
    setRetype(false); // Desktop Mode got the focus, or the setting went off
    typeAll('c');
    expect(run()).toBe('mine AB');
    expect(bar.shown()?.composition).toMatchObject({ before: 'C' });
    bar.flush();
    expect(run()).toBe('mine ABC');
    expect(backspaces()).toBe(0);
  });

  it('a composition waiting in the bar moves into the field as soon as it may', () => {
    const { bar, run, typeAll, setRetype } = setupField();
    setRetype(false);
    typeAll('ab');
    expect(run()).toBe('mine ');
    setRetype(true);
    typeAll('c');
    expect(run()).toBe('mine ABC');
    expect(bar.shown()?.composition).toMatchObject({ before: '' });
  });

  it('a conversion shows in the bar while the reading stays in the field; the pick replaces the reading', () => {
    const { bar, run, typeAll } = setupField();
    typeAll('ab?');
    expect(run()).toBe('mine AB');
    expect(bar.shown()?.composition).toMatchObject({ segments: ['<AB>'] });
    bar.pick('αβ', 0);
    expect(run()).toBe('mine αβ');
  });

  /** Letters compose two at a time, in capitals; a third commits the pair, as a syllable is sent once the next jamo cannot join it. */
  const pairs: Composer<string> = {
    empty: '',
    inline: true,
    composing: (s) => s !== '',
    press: (s, key, { typed }) => {
      if (typed !== undefined && /^[a-z]$/.test(typed)) {
        return s.length < 2 ? { state: s + typed.toUpperCase(), effects: [] } : { state: typed.toUpperCase(), effects: [{ kind: 'text', text: s }] };
      }
      return s && key.type === 'key' && key.key === 'Backspace' ? { state: s.slice(0, -1), effects: [] } : null;
    },
    flush: (s) => ({ state: '', effects: s ? [{ kind: 'text', text: s }] : [] }),
    show: (s) => ({ preedit: { before: s, after: '' }, labels: {} }),
  };
  const ENTER: KeyDef = { type: 'key', key: 'Enter' };

  it('where it cannot compose in the field, what it commits waits in the bar with the rest of the word, and nothing goes out', () => {
    const { bar, run, typeAll, setRetype } = setupField(pairs);
    setRetype(false);
    typeAll('abcde');
    expect([run(), bar.composedText(), bar.composing()]).toEqual(['mine ', 'ABCDE', true]);
    expect(bar.shown()?.composition).toMatchObject({ before: 'ABCDE' });
    for (const [left, taken] of [['ABCD', true], ['ABC', true], ['AB', true], ['A', true], ['', true], ['', false]] as const) {
      expect(bar.press(BS, {})).toBe(taken); // the composition, then the word; then the field's
      expect(bar.composedText()).toBe(left);
    }
    expect(run()).toBe('mine ');
  });

  it('Enter sends the word alone; Space and any other key leave it to the caller, which sends it first; a pick drops it', () => {
    const { bar, run, sent, typeAll, setRetype } = setupField(pairs);
    setRetype(false);
    typeAll('abc');
    expect(bar.press(ENTER, {})).toBe(true); // taken: Enter is not pressed
    expect([run(), sent.at(-1)]).toEqual(['mine ABC', [{ kind: 'text', text: 'ABC' }]]);
    expect(bar.press(ENTER, {})).toBe(false); // the bar is empty: Enter is the field's
    typeAll('de');
    expect(bar.press(char(' '), { typed: ' ' })).toBe(false);
    bar.flush(); // what the caller does before any key acts
    expect(run()).toBe('mine ABCDE');
    typeAll('fgh');
    bar.drop();
    bar.leave();
    expect([run(), bar.composing()]).toEqual(['mine ABCDE', false]);
    typeAll('ijk');
    bar.leave(); // another keyboard: the word goes out as it stands
    expect(run()).toBe('mine ABCDEIJK');
  });

  it('once it may compose in the field again, the word waiting in the bar goes first', () => {
    const { bar, run, typeAll, setRetype } = setupField(pairs);
    setRetype(false);
    typeAll('abc');
    expect([run(), bar.composedText()]).toEqual(['mine ', 'ABC']);
    setRetype(true);
    typeAll('d');
    expect([run(), bar.inField()]).toEqual(['mine ABCD', true]);
  });

  it('a composer that does not opt in keeps the bar', () => {
    const { bar, run, typeAll } = setupField(shout);
    typeAll('hi');
    expect([run(), bar.inField(), bar.composedText()]).toEqual(['mine ', false, 'HI']);
    bar.flush();
    expect(run()).toBe('mine HI');
  });

  /**
   * pairs, which can also convert (?) the word before what it composes, with it, into lower case: the
   * pick sends a Backspace for each character of the word before (ctx.before), then the text.
   */
  interface Reach { readonly s: string; readonly before: string | null }
  const reaching: Composer<Reach> = {
    empty: { s: '', before: null },
    inline: true,
    composing: (r) => r.s !== '' || r.before !== null,
    press: (r, key, input, c) => {
      if (key.type === 'char' && key.char === '?') return { state: { ...r, before: c.before ?? '' }, effects: [] };
      if (r.before !== null) return { state: { ...r, before: null }, effects: [] }; // any key ends the conversion
      const done = pairs.press(r.s, key, input, c);
      return done && { ...done, state: { s: done.state, before: null } };
    },
    flush: (r) => ({ state: { s: '', before: null }, effects: r.s ? [{ kind: 'text', text: r.s }] : [] }),
    show: (r) => (r.before !== null
      ? { preedit: { segments: [r.before + r.s], focus: 0, candidates: [(r.before + r.s).toLowerCase()], selected: 0 }, labels: {} }
      : { preedit: { before: r.s, after: '' }, labels: {} }),
    convert: {
      reading: (r) => (r.before ?? '') + r.s,
      converted: (r) => r,
      live: () => [],
      pick: (r, text) => (r.before === null ? { state: r, effects: [] } : {
        state: { s: '', before: null },
        effects: [...Array.from(r.before, (): Effect => ({ kind: 'key', key: 'Backspace' })), { kind: 'text', text }],
      }),
      cancel: (r) => (r.before === null ? r : { ...r, before: null }),
    },
  };
  const QUESTION = char('?');

  it('a conversion that reaches back gets the word before the composition, and its Backspaces delete it in the field', () => {
    const { bar, run, typeAll, backspaces } = setupField(reaching);
    typeAll('abcde');
    expect(run()).toBe('mine ABCDE'); // AB and CD sent, E composing in the field
    bar.press(QUESTION, {});
    expect(bar.shown()?.composition).toMatchObject({ segments: ['ABCDE'], candidates: ['abcde'] }); // ABCD before E
    bar.pick('abcde', 0);
    expect([run(), backspaces()]).toEqual(['mine abcde', 5]); // E, then ABCD
  });

  it('where it cannot compose in the field, its Backspaces take the word in the bar off first, then the field\'s', () => {
    const { bar, run, typeAll, backspaces, setRetype } = setupField(reaching);
    setRetype(false);
    typeAll('abcde'); // ABCD waits in the bar, E composing
    bar.press(QUESTION, {});
    bar.pick('abcde', 0);
    expect([run(), bar.composedText()]).toEqual(['mine ', 'abcde']); // replaced in the bar, nothing sent
    bar.flush();
    expect([run(), backspaces()]).toEqual(['mine abcde', 0]);
    typeAll('fgh');
    bar.press(ENTER, {}); // FGH sent alone: part of the word, in the field
    typeAll('ij');
    bar.press(QUESTION, {});
    expect(bar.shown()?.composition).toMatchObject({ segments: ['abcdeFGHIJ'] });
    bar.pick('abcdefghij', 0);
    expect([run(), bar.composedText()]).toEqual(['mine ', 'abcdefghij']); // 8 Backspaces into the field
    bar.flush();
    expect([run(), backspaces()]).toEqual(['mine abcdefghij', 8]);
  });

  it('when the field may have changed, a conversion that reaches back ends and the bar is drawn again; what waits stays', () => {
    const { bar, run, typeAll, backspaces, setRetype, shows } = setupField(reaching);
    setRetype(false);
    typeAll('abc');
    bar.press(QUESTION, {});
    shows.mockClear();
    expect(bar.lose()).toBe(false); // nothing was in the field
    expect(shows).toHaveBeenCalled();
    expect(bar.shown()?.composition).toMatchObject({ before: 'ABC' }); // the word and the composition, as they were
    bar.pick('abc', 0); // a candidate still on screen: nothing happens
    bar.flush();
    expect([run(), backspaces()]).toEqual(['mine ABC', 0]);
    shows.mockClear();
    bar.lose(); // no conversion: nothing to draw
    expect(shows).not.toHaveBeenCalled();
  });

  it('with the composition in the field, losing it ends the conversion too, and the bar is drawn again', () => {
    const { bar, run, typeAll, backspaces, shows } = setupField(reaching);
    typeAll('abc');
    expect(run()).toBe('mine ABC');
    bar.press(QUESTION, {});
    shows.mockClear();
    expect(bar.lose()).toBe(true);
    expect([shows.mock.calls.length, bar.shown()]).toEqual([1, null]);
    bar.pick('abc', 0);
    expect([run(), backspaces()]).toEqual(['mine ABC', 0]);
  });
});
