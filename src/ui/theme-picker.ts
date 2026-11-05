// Settings' theme dropdown: a control with the current theme's name and a swatch of its colours, which
// opens a list of every theme over the panel. Steam's popup does not open a native <select>, so it is
// drawn here. Taps and the laser's hover go through settings' `actions` like any option, and the list
// scrolls like settings' other lists (.scroll); closing it on a tap elsewhere is handled here.

import { ICONS } from './icons.js';

export interface ThemeChoice {
  id: string;
  name: string;
  /** A few of its colours (surface, key, accent) for the swatch. */
  swatch?: string[];
}

export const THEME_PICKER_CSS = `
.pick { flex: 1 1 0; min-width: 0; position: relative; display: flex; }
.pick > .opt, .pick-list .opt { justify-content: flex-start; gap: 8px; text-align: left; }
.pick-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pick .chev { flex: none; display: flex; color: var(--legend); transition: transform 0.12s; }
.pick.open .chev { transform: rotate(180deg); }
.swatch { flex: none; display: flex; width: 26px; height: 14px; overflow: hidden; border-radius: var(--radius-sm);
  box-shadow: 0 0 0 1px var(--divider); }
.swatch i { flex: 1; }
/* Over the rows below; the panel is short, so it scrolls past about five themes (open() fits it to the panel). */
.pick-list { position: absolute; z-index: 5; top: calc(100% + 3px); left: 0; right: 0; display: none; flex-direction: column; gap: 3px;
  padding: 3px; box-sizing: border-box; max-height: calc(var(--row-height) * 5 + 18px);
  background: var(--surface); border: 1px solid var(--divider); border-radius: var(--radius); box-shadow: var(--shadow); }
.pick.open .pick-list { display: flex; }
.pick-list .opt { flex: none; }
`;

export interface ThemePicker {
  readonly el: HTMLElement;
  /** While the list is open only the picker takes taps and hover; true if `target` is part of it then. */
  reaches(target: EventTarget | null): boolean;
  /** A touch started on `target`. */
  start(target: EventTarget | null): void;
  /**
   * A tap ended, or a click, on `target` (by default where the touch started). True if the picker took
   * it: a tap outside closing it. Else it is a tap for `actions`.
   */
  end(target?: EventTarget | null): boolean;
}

export const buildThemePicker = (
  doc: Document,
  themes: readonly ThemeChoice[],
  current: string,
  onPick: (id: string) => void,
  actions: Map<HTMLElement, () => void>,
): ThemePicker => {
  const el = (cls: string): HTMLElement => Object.assign(doc.createElement('div'), { className: cls });
  const face = (t: ThemeChoice | undefined, cls: string): HTMLElement => {
    const opt = el(cls);
    const swatch = el('swatch');
    for (const color of t?.swatch ?? []) {
      const band = doc.createElement('i');
      band.style.background = color;
      swatch.append(band);
    }
    opt.append(swatch, Object.assign(el('pick-name'), { textContent: t?.name ?? '' }));
    return opt;
  };

  const root = el('pick');
  const list = el('pick-list scroll');
  // Like the theme in use: an unknown id shows the first.
  const chosen = themes.find((t) => t.id === current) ?? themes[0];
  const button = face(chosen, 'opt');
  button.append(Object.assign(el('chev'), { innerHTML: ICONS.chevron }));
  root.append(button, list);

  let selected: HTMLElement | undefined;
  for (const t of themes) {
    const item = face(t, t === chosen ? 'opt on' : 'opt');
    if (t === chosen) selected = item;
    actions.set(item, () => {
      close();
      if (t.id !== chosen?.id) onPick(t.id);
    });
    list.append(item);
  }

  const isOpen = (): boolean => root.classList.contains('open');
  const close = (): void => { root.classList.remove('open'); };
  const open = (): void => {
    root.classList.add('open');
    // Down to the bottom of the column it is in (so the column never scrolls for it), the current theme in view.
    const column = root.parentElement?.closest('.scroll')?.getBoundingClientRect();
    const room = column ? column.bottom - button.getBoundingClientRect().bottom - 4 : 0;
    if (room > 40) list.style.maxHeight = `${room}px`;
    if (selected) list.scrollTop = Math.max(0, selected.offsetTop - (list.clientHeight - selected.offsetHeight) / 2);
  };
  actions.set(button, () => (isOpen() ? close() : open()));

  let started: EventTarget | null = null;
  return {
    el: root,
    reaches: (target) => !isOpen() || root.contains(target as Node),
    start: (target) => { started = target; },
    end: (target = started) => {
      started = null;
      if (isOpen() && !root.contains(target as Node)) {
        close();
        return true;
      }
      return false;
    },
  };
};
