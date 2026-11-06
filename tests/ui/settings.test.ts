// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { SLOP_PX } from '../../src/core/interaction.js';
import { createSettingsView, type SettingsInfo, type SettingsValues } from '../../src/ui/settings.js';
import { bundledBoot } from '../boot.js';

const touch = (el: Element, type: string, x = 0, y = 0) => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'changedTouches', { value: [{ clientX: x, clientY: y }] });
  el.dispatchEvent(e);
};
const tap = (el: Element) => {
  touch(el, 'touchstart');
  touch(el, 'touchend');
};

/** Settings with two bundled themes (Night Owl, Steam), plus `extra` made-up ones (to fill the list past what fits). */
const setup = (extra = 0) => {
  const boot = bundledBoot();
  const host = document.createElement('div');
  document.body.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const themes: SettingsInfo['themes'] = ['themes/night-owl', 'themes/steam']
    .map((id) => boot.catalog.themes[id]!)
    .map((t) => ({ id: t.id, name: t.name, swatch: [t.colors.surface, t.colors.key, t.colors.accent] }));
  for (let i = 1; i <= extra; i++)
    themes.push({ id: `themes/test-${i}`, name: `Test ${i}`, swatch: ['#000', '#111', '#f00'] });
  const changes: Partial<SettingsValues>[] = [];
  const view = createSettingsView(
    document,
    shadow,
    boot.catalog.themes['themes/steam']!,
    { theme: 'themes/steam', haptics: true, suggestions: true, dictation: false, dictationContinuous: false },
    {
      themes,
      version: 'test',
      errors: [],
      suggestions: false,
      keyboardName: 'English',
      options: [],
      tab: 'general',
      keyboards: { all: [], ring: [], language: 'en' },
    },
    {
      onTab: () => {},
      onChange: (c) => changes.push(c),
      onOption: () => {},
      onStock: () => {},
      onClose: () => {},
      onLanguage: () => {},
      onKeyboards: () => {},
    },
  );
  const picker = shadow.querySelector<HTMLElement>('.pick')!;
  const control = picker.firstElementChild as HTMLElement;
  const list = picker.querySelector<HTMLElement>('.pick-list')!;
  const item = (name: string) => [...list.querySelectorAll<HTMLElement>('.opt')].find((el) => el.textContent === name)!;
  const haptics = [...shadow.querySelectorAll<HTMLElement>('.row')]
    .find((r) => r.textContent === 'Haptics')!
    .querySelector<HTMLElement>('.switch')!;
  const isOpen = () => picker.classList.contains('open');
  const at = (hits: Element[]) =>
    Object.defineProperty(shadow, 'elementsFromPoint', { configurable: true, value: () => hits });
  return { view, shadow, picker, control, list, item, haptics, isOpen, at, changes };
};

describe('settings: the theme dropdown', () => {
  it('shows the current theme with a swatch; tapping it lists every theme, the current one marked', () => {
    const { control, list, isOpen, item } = setup();
    expect(control.textContent).toBe('Steam');
    const bands = [...control.querySelectorAll<HTMLElement>('.swatch i')].map((b) => b.style.background);
    expect(bands).toEqual(['rgb(35, 38, 46)', 'rgb(14, 20, 27)', 'rgb(26, 159, 255)']); // surface, key, accent
    expect(control.querySelector('svg')).not.toBeNull(); // the chevron
    expect(isOpen()).toBe(false);
    tap(control);
    expect(isOpen()).toBe(true);
    expect([...list.querySelectorAll('.opt')].map((el) => el.textContent)).toEqual(['Night Owl', 'Steam']);
    expect(item('Steam').classList.contains('on')).toBe(true);
    expect(item('Night Owl').classList.contains('on')).toBe(false);
  });

  it('picking a theme applies it and closes the list; picking the current one only closes it', () => {
    const { control, item, isOpen, changes } = setup();
    tap(control);
    tap(item('Steam'));
    expect(isOpen()).toBe(false);
    expect(changes).toEqual([]);
    tap(control);
    tap(item('Night Owl'));
    expect(isOpen()).toBe(false);
    expect(changes).toEqual([{ theme: 'themes/night-owl' }]);
  });

  it('the control again, or a tap outside, closes it; the outside tap does nothing else', () => {
    const { control, haptics, isOpen, changes } = setup();
    tap(control);
    tap(control);
    expect(isOpen()).toBe(false);
    tap(control);
    tap(haptics); // under or beside the list: it only closes it
    expect(isOpen()).toBe(false);
    expect(changes).toEqual([]);
    tap(haptics); // closed: the switch works again
    expect(changes).toEqual([{ haptics: false }]);
  });

  it('a mouse click works the same (the desktop fallback)', () => {
    const { control, item, haptics, isOpen, changes } = setup();
    control.click();
    expect(isOpen()).toBe(true);
    haptics.click();
    expect(isOpen()).toBe(false);
    control.click();
    item('Night Owl').click();
    expect(changes).toEqual([{ theme: 'themes/night-owl' }]);
  });

  it('the laser marks items as it crosses them (a tick each) and nothing under the open list', () => {
    const { view, control, item, list, haptics, at } = setup();
    at([control]);
    expect(view.hoverAt(1, 1)).toBe(true); // the control is an option like any other
    expect(control.classList.contains('hover')).toBe(true);
    tap(control);
    at([item('Night Owl').querySelector('.pick-name')!, item('Night Owl'), list, haptics]);
    expect(view.hoverAt(1, 2)).toBe(true);
    expect(item('Night Owl').classList.contains('hover')).toBe(true);
    expect(control.classList.contains('hover')).toBe(false);
    expect(view.hoverAt(1, 3)).toBe(false); // the same item: no second tick
    at([item('Steam'), list]);
    expect(view.hoverAt(1, 4)).toBe(true);
    expect(item('Steam').classList.contains('hover')).toBe(true);
    expect(item('Night Owl').classList.contains('hover')).toBe(false);
    at([list, haptics]); // the list's padding, over the Haptics switch
    expect(view.hoverAt(1, 5)).toBe(true); // off the item...
    expect(haptics.classList.contains('hover')).toBe(false); // ...and not onto the switch beneath
    at([haptics]);
    expect(view.hoverAt(1, 6)).toBe(false); // beside the list: still nothing while it is open
  });

  it('with more themes than fit, a drag scrolls the list instead of picking', () => {
    const { control, list, item, isOpen, changes } = setup(10);
    tap(control);
    expect(list.querySelectorAll('.opt')).toHaveLength(12);
    const t3 = item('Test 3');
    touch(t3, 'touchstart', 50, 200);
    touch(t3, 'touchmove', 50, 200 - SLOP_PX.list / 2); // within the slop: not yet a scroll
    expect(list.scrollTop).toBe(0);
    touch(t3, 'touchmove', 50, 140);
    expect(list.scrollTop).toBe(60);
    touch(t3, 'touchend', 50, 140);
    expect(isOpen()).toBe(true);
    expect(changes).toEqual([]);
    tap(item('Test 7')); // a tap still picks
    expect(changes).toEqual([{ theme: 'themes/test-7' }]);
  });
});
