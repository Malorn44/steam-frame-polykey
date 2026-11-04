// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { KeyDef, Layout } from '../../src/core/catalog.js';
import { NO_MODS } from '../../src/core/keyboard.js';
import { HOLD_MS, RELEASE_LOST_MS, REPEAT_DELAY_MS, REPEAT_MS } from '../../src/core/interaction.js';
import { createView } from '../../src/ui/view.js';
import { bundledBoot } from '../boot.js';

const setup = () => {
  const boot = bundledBoot();
  const host = document.createElement('div');
  document.body.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const pressed: KeyDef[] = [];
  const chosen: string[] = [];
  const view = createView(document, shadow, boot.catalog.layouts['en/qwerty']!, boot.catalog.themes['themes/night-owl']!,
    (k, alternate) => (alternate === undefined ? pressed.push(k) : chosen.push(alternate)));
  view.update(NO_MODS);
  const rows = [...shadow.querySelectorAll('.row')];
  const keyIn = (row: number, id: string) =>
    [...rows[row]!.querySelectorAll<HTMLElement>('.key')].find((el) => el.dataset['k'] === id)!;
  const labelOf = (el: HTMLElement) => el.querySelector('.lbl')!.textContent;
  return { view, shadow, rows, keyIn, labelOf, pressed, chosen, host };
};

const tap = (el: HTMLElement) => {
  el.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
};

describe('createView', () => {
  it('renders the toolbar and five rows with width weights', () => {
    const { shadow, rows, keyIn } = setup();
    const bar = [...shadow.querySelectorAll<HTMLElement>('.bar > *')].map((el) => el.dataset['k'] ?? el.className);
    expect(bar).toEqual(['settings', 'emoji', 'dictate', 'copy', 'cut', 'paste', 'menu', 'cands', 'comp', 'hide']); // close at the right end
    expect(rows).toHaveLength(5);
    expect(parseFloat(keyIn(4, ' ').style.flexBasis)).toBeCloseTo((7.25 / 15) * 100, 3); // exact share of the row
    // ↓ starts exactly where ↑ does: the same share of their rows before them.
    const before = (row: number, id: string) => {
      const keys = [...rows[row]!.querySelectorAll<HTMLElement>('.key')];
      return keys.slice(0, keys.findIndex((el) => el.dataset['k'] === id)).reduce((sum, el) => sum + parseFloat(el.style.flexBasis), 0);
    };
    expect(before(4, 'ArrowDown')).toBeCloseTo(before(3, 'ArrowUp'), 6);
    expect(keyIn(4, 'super').querySelector('svg')).not.toBeNull(); // Frame icon
  });

  it('shows small Shift and Fn legends, and labels follow the modifiers', () => {
    const { view, keyIn, rows, labelOf } = setup();
    const one = keyIn(0, '1');
    // Shift top left, Fn top right (in the Fn colour), the label beneath.
    expect([one.querySelector('.lg.tl')!.textContent, labelOf(one), one.querySelector('.lg.tr.t-fn')!.textContent]).toEqual(['!', '1', 'F1']);
    expect(keyIn(1, 'q').querySelector('.lg')).toBeNull(); // no Shift legend on letters
    view.update({ ...NO_MODS, shift: 'once' });
    expect(labelOf(keyIn(1, 'q'))).toBe('Q');
    expect([one.querySelector('.lg.tl')!.textContent, labelOf(one)]).toEqual(['1', '!']);
    view.update({ ...NO_MODS, fn: 'locked' });
    expect(labelOf(rows[0]!.querySelector<HTMLElement>('.key')!)).toBe('Esc');
    expect(labelOf(keyIn(0, '=')!)).toBe('F12');
    expect(one.querySelector('.lg.tr')).toBeNull();
    const fnKey = rows[4]!.querySelector<HTMLElement>('.key.mod')!;
    expect(fnKey.classList.contains('locked')).toBe(true);
  });

  it('a tap reports the key, and a touch is not also a click', () => {
    const { keyIn, pressed } = setup();
    const w = keyIn(1, 'w');
    tap(w);
    w.click();
    expect(pressed).toEqual([{ type: 'char', char: 'w' }]);
  });

  it('setBounds positions the keyboard, destroy removes it', () => {
    const { view, shadow } = setup();
    view.setBounds({ top: 0, left: 0, width: 854, height: 239 });
    const root = shadow.querySelector<HTMLElement>('.kb')!;
    expect([root.style.width, root.style.height]).toEqual(['854px', '239px']);
    view.destroy();
    expect(shadow.querySelector('.kb')).toBeNull();
  });
});

describe('hover', () => {
  it('hoverAt marks the key under the laser and reports changes', () => {
    const { view, keyIn, shadow } = setup();
    const q = keyIn(1, 'q');
    Object.defineProperty(shadow, 'elementsFromPoint', { value: (x: number) => (x === 10 ? [q.firstChild, q] : []) });
    expect(view.hoverAt(10, 10)).toBe(true);
    expect(q.classList.contains('hover')).toBe(true);
    expect(view.hoverAt(10, 10)).toBe(false);
    expect(view.hoverAt(0, 0)).toBe(true);
    expect(q.classList.contains('hover')).toBe(false);
  });

  it('a gap is nothing to hover: no change while the laser stays on it (no haptic buzz)', () => {
    const boot = bundledBoot();
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const view = createView(document, shadow, boot.catalog.layouts['ja/gojuon']!, boot.catalog.themes['themes/steam']!, () => {});
    view.update(NO_MODS);
    const gap = shadow.querySelector<HTMLElement>('.key.gap')!;
    const wa = [...shadow.querySelectorAll<HTMLElement>('.key')].find((el) => el.dataset['k'] === 'わ')!;
    Object.defineProperty(shadow, 'elementsFromPoint', { value: (x: number) => (x === 10 ? [gap] : x === 20 ? [wa] : []) });
    expect(view.hoverAt(10, 10)).toBe(false); // from nothing to a gap: still nothing
    expect(view.hoverAt(10, 11)).toBe(false);
    expect(view.hoverAt(10, 12)).toBe(false);
    expect(gap.classList.contains('hover')).toBe(false);
    expect(view.hoverAt(20, 10)).toBe(true); // onto a key
    expect(view.hoverAt(10, 10)).toBe(true); // off it, into the gap: the hover ends, once
    expect(view.hoverAt(10, 11)).toBe(false);
  });
});

describe('icons', () => {
  const render = (layout: Partial<Layout>) => {
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const full: Layout = { id: 't/t', name: 't', toolbar: [], rows: [], ...layout } as Layout;
    createView(document, shadow, full, bundledBoot().catalog.themes['themes/steam']!, () => {}).update(NO_MODS);
    const key = (k: string) => [...shadow.querySelectorAll<HTMLElement>('.kb .key')].find((el) => el.dataset['k'] === k)!;
    return { key, svg: (k: string) => key(k).querySelector('svg'), text: (k: string) => key(k).querySelector('.lbl')!.textContent };
  };

  it('draws the icon set\'s defaults: phone adds Enter and arrows; large layouts default to phone', () => {
    const rows: Layout['rows'] = [[{ type: 'key', key: 'Enter' }, { type: 'key', key: 'ArrowLeft' }, { type: 'action', action: 'settings' }]];
    const desktop = render({ rows });
    expect(desktop.svg('Enter')).toBeNull();
    expect(desktop.text('ArrowLeft')).toBe('←');
    expect(desktop.svg('settings')).not.toBeNull();
    for (const phone of [render({ rows, large: true }), render({ rows, iconSet: 'phone' })]) {
      expect(phone.svg('Enter')).not.toBeNull();
      expect(phone.svg('ArrowLeft')).not.toBeNull();
    }
    expect(render({ rows, large: true, iconSet: 'desktop' }).svg('Enter')).toBeNull(); // set on its own
  });

  it('arrowStyle glyph draws arrows as text; a key\'s own icon wins, null meaning text', () => {
    const glyph = render({ large: true, arrowStyle: 'glyph', rows: [[{ type: 'key', key: 'ArrowLeft' }, { type: 'key', key: 'Enter' }]] });
    expect(glyph.svg('ArrowLeft')).toBeNull();
    expect(glyph.text('ArrowLeft')).toBe('←');
    expect(glyph.svg('Enter')).not.toBeNull();
    const own = render({ rows: [[{ type: 'key', key: 'Tab', icon: 'right' }, { type: 'action', action: 'settings', icon: null },
      { type: 'char', char: ' ', label: 'Space' }]] });
    expect(own.svg('Tab')).not.toBeNull();
    expect(own.svg('settings')).toBeNull();
    expect(own.svg(' ')).toBeNull(); // a label still means text
  });

  it('the schema lists every icon', async () => {
    const { readFileSync } = await import('node:fs');
    const { ICONS } = await import('../../src/ui/icons.js');
    const schema = JSON.parse(readFileSync('schema/pack.schema.json', 'utf8'));
    expect(schema.$defs.icon.enum).toEqual([...Object.keys(ICONS), null]);
  });
});

describe('long press', () => {
  const touch = (el: Element, type: string, x = 0, y = 0) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'changedTouches', { value: [{ clientX: x, clientY: y }] });
    el.dispatchEvent(e);
  };

  it('offers the key and its variants (no capital); release types the pick', () => {
    vi.useFakeTimers();
    const { keyIn, shadow, pressed, chosen } = setup();
    const e = keyIn(1, 'e');
    touch(e, 'touchstart');
    vi.advanceTimersByTime(HOLD_MS);
    const cells = [...shadow.querySelectorAll<HTMLElement>('.alts .key')];
    expect(cells.map((c) => c.textContent)).toEqual(['e', 'è', 'é', 'ê', 'ë', 'ē', 'ė', 'ę']);
    expect(cells[0]!.classList.contains('pick')).toBe(true);
    Object.defineProperty(shadow, 'elementsFromPoint', { configurable: true, value: (x: number) => (x === 5 ? [cells[2]] : []) });
    touch(e, 'touchmove', 5, 5);
    expect(cells[2]!.classList.contains('pick')).toBe(true);
    touch(e, 'touchend');
    expect(chosen).toEqual(['é']);
    expect(pressed).toEqual([]);
    expect(shadow.querySelector('.alts')).toBeNull();
    vi.useRealTimers();
  });

  it('picks by horizontal position, keeps the pick while on the key, cancels far away', () => {
    vi.useFakeTimers();
    const { keyIn, shadow, chosen } = setup();
    const e = keyIn(1, 'e');
    const rect = (left: number, top: number) => ({ left, right: left + 40, top, bottom: top + 30, width: 40, height: 30 }) as DOMRect;
    e.getBoundingClientRect = () => rect(100, 60); // the held key
    touch(e, 'touchstart', 110, 75);
    vi.advanceTimersByTime(HOLD_MS);
    const cells = [...shadow.querySelectorAll<HTMLElement>('.alts .key')];
    cells.forEach((cell, i) => { cell.getBoundingClientRect = () => rect(100 + i * 40, 28); });
    Object.defineProperty(shadow, 'elementsFromPoint', { configurable: true, value: () => [] });
    touch(e, 'touchmove', 110, 75); // on the key, under the first cell
    expect(cells[0]!.classList.contains('pick')).toBe(true);
    touch(e, 'touchmove', 190, 75); // under the third cell
    expect(cells[2]!.classList.contains('pick')).toBe(true);
    touch(e, 'touchend');
    expect(chosen).toEqual(['é']);
    touch(e, 'touchstart');
    vi.advanceTimersByTime(HOLD_MS);
    [...shadow.querySelectorAll<HTMLElement>('.alts .key')].forEach((cell, i) => { cell.getBoundingClientRect = () => rect(100 + i * 40, 28); });
    touch(e, 'touchmove', 110, 200); // well below the key
    touch(e, 'touchend');
    expect(chosen).toEqual(['é']); // cancelled
  });

  it('the laser moving the pick to another choice reports it once (a haptic tick); opening does not', () => {
    vi.useFakeTimers();
    const { view, keyIn, shadow } = setup();
    const e = keyIn(1, 'e');
    const rect = (left: number, top: number) => ({ left, right: left + 40, top, bottom: top + 30, width: 40, height: 30 }) as DOMRect;
    e.getBoundingClientRect = () => rect(100, 60);
    touch(e, 'touchstart', 110, 75);
    vi.advanceTimersByTime(HOLD_MS);
    const cells = [...shadow.querySelectorAll<HTMLElement>('.alts .key')];
    cells.forEach((cell, i) => { cell.getBoundingClientRect = () => rect(100 + i * 40, 28); });
    Object.defineProperty(shadow, 'elementsFromPoint', { configurable: true, value: () => [] });
    expect(view.hoverAt(110, 75)).toBe(false); // still on the first choice
    expect(view.hoverAt(150, 75)).toBe(true); // onto the second: one tick
    expect(view.hoverAt(155, 75)).toBe(false); // same choice: none
    touch(e, 'touchmove', 190, 75); // a touch move onto the third...
    expect(view.hoverAt(190, 75)).toBe(true); // ...ticks on the next laser report
    touch(e, 'touchend');
  });

  it('opens on the cell above the laser, never on the first one first', () => {
    vi.useFakeTimers();
    const { keyIn, shadow } = setup();
    const e = keyIn(1, 'e');
    const rect = (left: number, top: number) => ({ left, right: left + 40, top, bottom: top + 30, width: 40, height: 30 }) as DOMRect;
    e.getBoundingClientRect = () => rect(100, 60);
    // Lay out cells as soon as they are created, so the opening pick can use them.
    const realAppend = HTMLElement.prototype.append;
    let n = 0;
    HTMLElement.prototype.append = function (...nodes) {
      for (const node of nodes) if (node instanceof HTMLElement && node.parentElement === null && this.className === 'alts') {
        const i = n++;
        node.getBoundingClientRect = () => rect(100 + i * 40, 28);
      }
      return realAppend.apply(this, nodes);
    };
    touch(e, 'touchstart', 150, 75); // laser under the second cell
    vi.advanceTimersByTime(HOLD_MS);
    HTMLElement.prototype.append = realAppend;
    const cells = [...shadow.querySelectorAll<HTMLElement>('.alts .key')];
    expect(cells.map((c) => c.classList.contains('pick'))).toEqual([false, true, false, false, false, false, false, false]);
    vi.useRealTimers();
  });

  it('a short press is a plain tap', () => {
    vi.useFakeTimers();
    const { keyIn, pressed } = setup();
    const e = keyIn(1, 'e');
    touch(e, 'touchstart');
    vi.advanceTimersByTime(HOLD_MS - 50);
    touch(e, 'touchend');
    expect(pressed.map((k) => k.type === 'char' && k.char)).toEqual(['e']);
    vi.useRealTimers();
  });

  it('a key with nothing to choose just types on release', () => {
    vi.useFakeTimers();
    const { keyIn, shadow, pressed } = setup();
    const q = keyIn(1, 'q'); // no variants, and its capital is not one
    touch(q, 'touchstart');
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(shadow.querySelector('.alts')).toBeNull();
    touch(q, 'touchend');
    expect(pressed).toHaveLength(1);
    vi.useRealTimers();
  });

  it('arranges legends as a triangle with Fn, stacked with only Shift, and none on letters', () => {
    const { keyIn, view } = setup();
    expect([...keyIn(0, '1').classList].filter((c) => c === 'tri' || c === 'stack')).toEqual(['tri']);
    expect([...keyIn(1, '[').classList].filter((c) => c === 'tri' || c === 'stack')).toEqual(['stack']);
    expect([...keyIn(1, 'q').classList].filter((c) => c === 'tri' || c === 'stack')).toEqual([]);
    view.update({ ...NO_MODS, fn: 'once' }); // Fn on: F1 is the label, no legends
    expect(keyIn(0, '1').classList.contains('tri')).toBe(false);
  });
});

describe('hold to repeat', () => {
  const touch = (el: Element, type: string) => el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));

  it('a held Backspace repeats after a delay and does not type again on release', () => {
    vi.useFakeTimers();
    const { keyIn, pressed, shadow } = setup();
    const backspace = keyIn(0, 'Backspace');
    touch(backspace, 'touchstart');
    vi.advanceTimersByTime(REPEAT_DELAY_MS - 1);
    expect(pressed).toHaveLength(0);
    vi.advanceTimersByTime(1 + REPEAT_MS * 3);
    expect(pressed).toHaveLength(4);
    touch(backspace, 'touchend');
    vi.advanceTimersByTime(REPEAT_MS * 5);
    expect(pressed).toHaveLength(4);
    expect(shadow.querySelector('.alts')).toBeNull();
    vi.useRealTimers();
  });

  it('a quick tap types once; Space repeats; letters do not', () => {
    vi.useFakeTimers();
    const { keyIn, pressed } = setup();
    const left = keyIn(4, 'ArrowLeft');
    touch(left, 'touchstart');
    touch(left, 'touchend');
    expect(pressed).toHaveLength(1);
    const space = keyIn(4, ' ');
    touch(space, 'touchstart');
    vi.advanceTimersByTime(REPEAT_DELAY_MS + REPEAT_MS * 2);
    touch(space, 'touchend');
    expect(pressed).toHaveLength(4); // the tap, then three spaces while held
    const q = keyIn(1, 'q');
    touch(q, 'touchstart');
    vi.advanceTimersByTime(REPEAT_DELAY_MS + REPEAT_MS * 5);
    touch(q, 'touchend');
    expect(pressed).toHaveLength(5);
    vi.useRealTimers();
  });

  it('boxes the dotted characters on the 12-key: ゛゜ on the modify key, 、 and its 。 hint', () => {
    const boot = bundledBoot();
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const view = createView(document, shadow, boot.catalog.layouts['ja/flick']!, boot.catalog.themes['themes/steam']!, () => {});
    view.update(NO_MODS);
    const keys = [...shadow.querySelectorAll<HTMLElement>('.key')];
    const modify = keys.find((el) => el.dataset['k'] === 'modify')!;
    // Full-width cells; the marks as combining marks on a full-width space, so they sit high right.
    expect([...modify.querySelectorAll('.mk-marks .dot.cell.mark .ch')].map((el) => el.textContent)).toEqual(['\u3000\u3099', '\u3000\u309a']);
    expect(modify.querySelector('.mk-size')?.textContent).toBe('大⇔小');
    const punct = keys.find((el) => el.dataset['k'] === '、')!;
    expect(punct.querySelector('.lbl .dot.cell')?.textContent).toBe('、');
    expect(punct.querySelector('.lg.l .dot.cell')?.textContent).toBe('。');
    expect(punct.querySelector('.lg.t .dot')).toBeNull();
  });

  it('a flick key shows its kana in a cross while held, and the flick picks one', () => {
    const boot = bundledBoot();
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const got: [string, string | undefined][] = [];
    const view = createView(document, shadow, boot.catalog.layouts['ja/flick']!, boot.catalog.themes['themes/steam']!,
      (k, alternate) => got.push([k.type === 'flick' ? k.flick[0] : '?', alternate]));
    view.update(NO_MODS);
    const ka = [...shadow.querySelectorAll<HTMLElement>('.key')].find((el) => el.dataset['k'] === 'か')!;
    const at = (type: string, x: number, y: number) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'changedTouches', { value: [{ clientX: x, clientY: y }] });
      ka.dispatchEvent(e);
    };
    at('touchstart', 100, 100);
    expect([...shadow.querySelectorAll('.fl div')].map((c) => c.textContent)).toEqual(['か', 'き', 'く', 'け', 'こ']);
    // Unlaid-out (jsdom: zero-size) keyboard: the cross still sits inside, its cells text-sized.
    const guide = shadow.querySelector<HTMLElement>('.fl')!;
    expect([guide.style.left, guide.style.top]).toEqual(['31px', '31px']);
    expect(shadow.querySelector<HTMLElement>('.fl div')!.style.width).toBe('28px');
    at('touchmove', 100, 60); // up
    expect(shadow.querySelector('.fl .pick')!.textContent).toBe('く');
    at('touchend', 100, 60);
    expect(shadow.querySelector('.fl')).toBeNull();
    at('touchstart', 100, 100);
    at('touchend', 104, 102); // a tap: the keyboard decides what it types
    expect(got).toEqual([['か', 'く'], ['か', undefined]]);
  });

  it('candidates scroll by dragging (a short press still picks), and can sit in a panel on the left', () => {
    const boot = bundledBoot();
    const make = (side: boolean) => {
      const host = document.createElement('div');
      document.body.append(host);
      const shadow = host.attachShadow({ mode: 'open' });
      const picked: string[] = [];
      const view = createView(document, shadow, boot.catalog.layouts['ja/flick']!, boot.catalog.themes['themes/steam']!,
        () => {}, () => {}, (text) => picked.push(text), { side });
      view.update(NO_MODS);
      view.setComposition({ before: 'かんじ', after: '', candidates: ['漢字', '感じ', '幹事'], selected: -1 });
      return { shadow, picked };
    };
    const { shadow, picked } = make(false);
    const cand = [...shadow.querySelectorAll<HTMLElement>('.cand')][1]!;
    const at = (type: string, x: number) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'changedTouches', { value: [{ clientX: x, clientY: 10 }] });
      cand.dispatchEvent(e);
    };
    at('touchstart', 200);
    at('touchmove', 150); // a drag: scrolls, no pick
    at('touchend', 150);
    at('touchstart', 200);
    at('touchend', 203); // a press: picks
    expect(picked).toEqual(['感じ']);
    const left = make(true).shadow;
    // Flick hints: the other four kana at the key's edges, left, up, right, down.
    const host = document.createElement('div');
    document.body.append(host);
    const hinted = host.attachShadow({ mode: 'open' });
    createView(document, hinted, boot.catalog.layouts['ja/flick']!, boot.catalog.themes['themes/steam']!, () => {}, () => {}, () => {}, { hints: true }).update(NO_MODS);
    const ka = [...hinted.querySelectorAll<HTMLElement>('.key')].find((el) => el.dataset['k'] === 'か')!;
    expect([...ka.querySelectorAll('.lg')].map((h) => `${h.className}:${h.textContent}`))
      .toEqual(['lg t s-hint t-legend:く', 'lg l s-hint t-legend:き', 'lg r s-hint t-legend:け', 'lg b s-hint t-legend:こ']);
    const punct = [...hinted.querySelectorAll<HTMLElement>('.key')].find((el) => el.dataset['k'] === '、')!;
    expect(punct.querySelector('.lbl')!.textContent).toBe('、'); // with hints, just its tap kana
    // The punctuation key always shows its directions, hints option or not.
    const plain = document.createElement('div');
    document.body.append(plain);
    const noHints = plain.attachShadow({ mode: 'open' });
    createView(document, noHints, boot.catalog.layouts['ja/flick']!, boot.catalog.themes['themes/steam']!, () => {}).update(NO_MODS);
    const keysOf = (id: string) => [...noHints.querySelectorAll<HTMLElement>('.key')].find((el) => el.dataset['k'] === id)!;
    expect([...keysOf('、').querySelectorAll('.lg')].map((h) => h.textContent)).toEqual(['？', '。', '！', '…']);
    expect(keysOf('か').querySelectorAll('.lg')).toHaveLength(0);
    expect(left.querySelector('.kb.side .sidep .comp .list')).not.toBeNull();
    expect(left.querySelector('.sidep .bar')).not.toBeNull(); // the toolbar sits under the candidates
  });
});


describe('swipe', () => {
  const touch = (el: Element, type: string, x = 0, y = 0) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'changedTouches', { value: [{ clientX: x, clientY: y }] });
    el.dispatchEvent(e);
  };
  /** The view with swipe on, its keys laid out on a grid of 40×30 px cells (row r, column c). */
  const swipeSetup = () => {
    const boot = bundledBoot();
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const pressed: KeyDef[] = [];
    const chosen: string[] = [];
    const swipes: { path: { x: number; y: number }[]; keys: Record<string, [number, number]>; width: number }[] = [];
    const view = createView(document, shadow, boot.catalog.layouts['en/qwerty']!, boot.catalog.themes['themes/night-owl']!,
      (k, alternate) => (alternate === undefined ? pressed.push(k) : chosen.push(alternate)), undefined, undefined,
      { onSwipe: (path, keys, width) => swipes.push({ path, keys, width }) });
    view.update(NO_MODS);
    const rows = [...shadow.querySelectorAll('.row')];
    rows.forEach((row, r) => [...row.querySelectorAll<HTMLElement>('.key')].forEach((el, c) => {
      el.getBoundingClientRect = () => ({ left: c * 40, right: c * 40 + 40, top: r * 30, bottom: r * 30 + 30, width: 40, height: 30 }) as DOMRect;
    }));
    const keyIn = (row: number, id: string) => [...rows[row]!.querySelectorAll<HTMLElement>('.key')].find((el) => el.dataset['k'] === id)!;
    return { view, shadow, keyIn, pressed, chosen, swipes };
  };

  it('a press that leaves its letter key traces a path instead of typing, with a trail that fades', () => {
    vi.useFakeTimers();
    const { keyIn, shadow, pressed, swipes } = swipeSetup();
    const q = keyIn(1, 'q'); // row 1, column 1: x 40-80, y 30-60
    touch(q, 'touchstart', 60, 45);
    touch(q, 'touchmove', 75, 45); // still on q
    expect(shadow.querySelector('.trail')).toBeNull();
    touch(q, 'touchmove', 100, 45); // on w, a third of a key past q's edge: a swipe
    expect(q.classList.contains('down')).toBe(false);
    expect(shadow.querySelector('.trail polyline')!.getAttribute('points')).toBe('60,45 75,45 100,45 ');
    touch(q, 'touchmove', 140, 45);
    touch(q, 'touchend', 140, 45); // on e
    expect(pressed).toEqual([]);
    expect(swipes).toHaveLength(1);
    const { path, keys, width } = swipes[0]!;
    expect([path[0], path[path.length - 1]]).toEqual([{ x: 60, y: 45 }, { x: 140, y: 45 }]);
    expect(keys['q']).toEqual([60, 45]);
    expect(keys['a']).toEqual([60, 75]); // after Caps, a row down
    expect(Object.keys(keys).sort().join('')).toBe('abcdefghijklmnopqrstuvwxyz'); // letters only
    expect(width).toBe(40);
    expect(shadow.querySelector('.trail')!.classList.contains('fade')).toBe(true);
    vi.advanceTimersByTime(300);
    expect(shadow.querySelector('.trail')).toBeNull();
    vi.useRealTimers();
  });

  it('a tap, and a wobble near the key\'s edge, still type the letter', () => {
    const { keyIn, pressed, swipes } = swipeSetup();
    const w = keyIn(1, 'w'); // x 80-120
    touch(w, 'touchstart', 115, 45);
    touch(w, 'touchend', 115, 45);
    touch(w, 'touchstart', 115, 45);
    touch(w, 'touchmove', 130, 45); // outside, but not by a third of a key
    touch(w, 'touchend', 130, 45);
    expect(pressed.map((k) => k.type === 'char' && k.char)).toEqual(['w', 'w']);
    expect(swipes).toEqual([]);
  });

  it('holding a letter still opens its alternates, and moving then picks one (no swipe)', () => {
    vi.useFakeTimers();
    const { keyIn, shadow, chosen, swipes } = swipeSetup();
    const e = keyIn(1, 'e'); // x 120-160
    touch(e, 'touchstart', 140, 45);
    vi.advanceTimersByTime(HOLD_MS);
    const cells = [...shadow.querySelectorAll<HTMLElement>('.alts .key')];
    cells.forEach((cell, i) => { cell.getBoundingClientRect = () => ({ left: 120 + i * 40, right: 160 + i * 40, top: 10, bottom: 40, width: 40, height: 30 }) as DOMRect; });
    Object.defineProperty(shadow, 'elementsFromPoint', { configurable: true, value: () => [] });
    touch(e, 'touchmove', 220, 45); // well outside e: the third choice, not a swipe
    touch(e, 'touchend', 220, 45);
    expect(chosen).toEqual(['é']);
    expect(swipes).toEqual([]);
    expect(shadow.querySelector('.trail')).toBeNull();
    vi.useRealTimers();
  });

  it('a swipe that starts quickly never opens the alternates', () => {
    vi.useFakeTimers();
    const { keyIn, shadow, swipes } = swipeSetup();
    const e = keyIn(1, 'e');
    touch(e, 'touchstart', 140, 45);
    touch(e, 'touchmove', 190, 45);
    vi.advanceTimersByTime(HOLD_MS * 2); // a slow swipe
    expect(shadow.querySelector('.alts')).toBeNull();
    touch(e, 'touchend', 200, 45);
    expect(swipes).toHaveLength(1);
    vi.useRealTimers();
  });

  it('a letter without alternates may rest before it swipes', () => {
    vi.useFakeTimers();
    const { keyIn, pressed, swipes } = swipeSetup();
    const q = keyIn(1, 'q');
    touch(q, 'touchstart', 60, 45);
    for (let i = 0; i < 2100; i++) touch(q, 'touchmove', 60 + (i % 2), 45); // resting, the laser trembling
    vi.advanceTimersByTime(HOLD_MS * 2);
    touch(q, 'touchmove', 140, 45);
    touch(q, 'touchend', 140, 45);
    expect([pressed, swipes.length]).toEqual([[], 1]);
    expect(swipes[0]!.path[0]).toEqual({ x: 60, y: 45 }); // where it started is kept
    vi.useRealTimers();
  });

  it('only letters start a swipe; Space, Backspace and digits keep their taps and repeats', () => {
    vi.useFakeTimers();
    const { keyIn, pressed, swipes } = swipeSetup();
    const space = keyIn(4, ' ');
    touch(space, 'touchstart', 180, 135);
    touch(space, 'touchmove', 300, 135);
    touch(space, 'touchend', 300, 135);
    const one = keyIn(0, '1');
    touch(one, 'touchstart', 60, 15);
    touch(one, 'touchmove', 140, 15);
    touch(one, 'touchend', 140, 15);
    const backspace = keyIn(0, 'Backspace');
    touch(backspace, 'touchstart', 540, 15);
    vi.advanceTimersByTime(REPEAT_DELAY_MS + REPEAT_MS);
    touch(backspace, 'touchend', 540, 15);
    expect(swipes).toEqual([]);
    expect(pressed.map((k) => (k.type === 'char' ? k.char : k.type === 'key' ? k.key : ''))).toEqual([' ', '1', 'Backspace', 'Backspace']);
    vi.useRealTimers();
  });

  it('not while Ctrl makes letters shortcuts', () => {
    const { view, keyIn, pressed, swipes } = swipeSetup();
    view.update({ ...NO_MODS, ctrl: 'once' });
    const q = keyIn(1, 'q');
    touch(q, 'touchstart', 60, 45);
    touch(q, 'touchmove', 140, 45);
    touch(q, 'touchend', 140, 45);
    expect(swipes).toEqual([]);
    expect(pressed).toHaveLength(1);
  });

  it('a lost release (the laser moves on without touch moves) ends the swipe without typing', () => {
    vi.useFakeTimers();
    const { view, keyIn, shadow, pressed, swipes } = swipeSetup();
    Object.defineProperty(shadow, 'elementsFromPoint', { configurable: true, value: () => [] });
    const q = keyIn(1, 'q');
    touch(q, 'touchstart', 60, 45);
    touch(q, 'touchmove', 120, 45);
    vi.advanceTimersByTime(RELEASE_LOST_MS + 10);
    view.hoverAt(300, 100);
    expect(shadow.querySelector('.trail')).toBeNull();
    touch(q, 'touchend', 300, 100);
    expect([pressed, swipes]).toEqual([[], []]);
    vi.useRealTimers();
  });

  it('without onSwipe, moving off a letter is still a plain tap', () => {
    const { keyIn, pressed } = setup();
    const q = keyIn(1, 'q');
    touch(q, 'touchstart', 60, 45);
    touch(q, 'touchmove', 300, 45);
    touch(q, 'touchend', 300, 45);
    expect(pressed).toHaveLength(1);
  });
});
