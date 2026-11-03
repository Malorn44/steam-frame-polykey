// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { KeyDef } from '../../src/core/catalog.js';
import { NO_MODS } from '../../src/core/keyboard.js';
import { LONG_PRESS_MS, REPEAT_DELAY_MS, REPEAT_MS, createView } from '../../src/ui/view.js';
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
  const labelOf = (el: HTMLElement) => el.children[1]!.textContent;
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
    expect(bar).toEqual(['settings', 'emoji', 'dictate', 'copy', 'cut', 'paste', 'menu', 'cands', 'hide']); // close at the right end
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
    expect([one.querySelector('.sh')!.textContent, labelOf(one), one.querySelector('.fn')!.textContent]).toEqual(['!', '1', 'F1']);
    expect(keyIn(1, 'q').querySelector('.sh')!.textContent).toBe(''); // no Shift legend on letters
    view.update({ ...NO_MODS, shift: 'once' });
    expect(labelOf(keyIn(1, 'q'))).toBe('Q');
    expect([one.querySelector('.sh')!.textContent, labelOf(one)]).toEqual(['1', '!']);
    view.update({ ...NO_MODS, fn: 'locked' });
    expect(labelOf(rows[0]!.querySelector<HTMLElement>('.key')!)).toBe('Esc');
    expect(labelOf(keyIn(0, '=')!)).toBe('F12');
    expect(one.querySelector('.fn')!.textContent).toBe('');
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
    vi.advanceTimersByTime(LONG_PRESS_MS);
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
    vi.advanceTimersByTime(LONG_PRESS_MS);
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
    vi.advanceTimersByTime(LONG_PRESS_MS);
    [...shadow.querySelectorAll<HTMLElement>('.alts .key')].forEach((cell, i) => { cell.getBoundingClientRect = () => rect(100 + i * 40, 28); });
    touch(e, 'touchmove', 110, 200); // well below the key
    touch(e, 'touchend');
    expect(chosen).toEqual(['é']); // cancelled
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
    vi.advanceTimersByTime(LONG_PRESS_MS);
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
    vi.advanceTimersByTime(LONG_PRESS_MS - 50);
    touch(e, 'touchend');
    expect(pressed.map((k) => k.type === 'char' && k.char)).toEqual(['e']);
    vi.useRealTimers();
  });

  it('a key with nothing to choose just types on release', () => {
    vi.useFakeTimers();
    const { keyIn, shadow, pressed } = setup();
    const q = keyIn(1, 'q'); // no variants, and its capital is not one
    touch(q, 'touchstart');
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
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
});
