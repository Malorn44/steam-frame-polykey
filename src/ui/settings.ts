// The settings page, drawn in the keyboard area instead of the keys while open. Two tabs: Settings has
// General (theme, haptics, suggestions) on the left, the current keyboard's own options on the right,
// and the version and any pack errors at the bottom; Keyboards picks and orders the keyboards 🌐 goes
// through (ui/keyboards-page.ts). Changes apply at once; ✕ goes back to the keys, and "Steam keyboard"
// hands over to Steam's own (🌐 skips it).

import type { Theme } from '../core/catalog.js';
import { touchGuard } from '../core/interaction.js';
import { listenTouch } from './gesture.js';
import { ICONS } from './icons.js';
import { sizeVars } from './sizes.js';
import { themeVars } from './theme.js';
import { KEYBOARDS_CSS, buildKeyboardsPage, inlineIcon, type KeyboardsHandlers, type KeyboardsInfo } from './keyboards-page.js';

export type SettingsTab = 'general' | 'keyboards';

export interface SettingsValues {
  theme: string;
  haptics: boolean;
  suggestions: boolean;
}

export interface SettingsInfo {
  themes: { id: string; name: string }[];
  version: string;
  errors: string[];
  /** Whether the current keyboard has word suggestions (a word list); without, that row is hidden. */
  suggestions: boolean;
  /** The current keyboard's name, heading its options. */
  keyboardName: string;
  /** The current keyboard's options: a name and its two choices. */
  options: { id: string; name: string; off: string; on: string; toggle?: boolean; invert?: boolean; value: boolean }[];
  tab: SettingsTab;
  keyboards: KeyboardsInfo;
}

export interface SettingsHandlers extends KeyboardsHandlers {
  onTab(tab: SettingsTab): void;
  onChange(changes: Partial<SettingsValues>): void;
  onOption(id: string, value: boolean): void;
  onStock(): void;
  onClose(): void;
}

const CSS = `
.panel { position: fixed; box-sizing: border-box; display: flex; flex-direction: column; gap: 4px; padding: 4px 10px;
  background: var(--surface); color: var(--text); font: 400 var(--ui-text)/1.2 var(--font);
  pointer-events: auto; touch-action: none; user-select: none; -webkit-user-select: none; }
.head { display: flex; align-items: center; height: var(--bar-height); font-size: var(--ui-title); font-weight: 600; }
.head .title { flex: 1; }
.head .tab { flex: none; min-width: 0; margin-right: 6px; padding: 2px 12px; font-size: var(--ui-control); }
.head .tab.on { background: var(--accent); color: var(--accent-text); }
.cols { flex: 1; display: flex; gap: 14px; min-height: 0; }
.col { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.sect { font-size: var(--ui-caption); font-weight: 600; letter-spacing: 0.04em; color: var(--legend);
  border-bottom: 1px solid var(--divider); padding-bottom: 3px; margin-bottom: 1px; white-space: nowrap; overflow: hidden; }
.none { color: var(--legend); font-size: var(--ui-small); padding-top: 4px; }
.row { display: flex; align-items: center; gap: 6px; min-height: var(--row-height); }
.row .name { flex: none; width: 104px; color: var(--text); font-size: var(--ui-control); }
.opt { flex: 1 1 0; min-width: 0; display: flex; align-items: center; justify-content: center; min-height: var(--row-height); padding: 2px 8px;
  box-sizing: border-box; background: var(--mod); border-radius: var(--radius); font-size: var(--ui-control); line-height: 1.1;
  text-align: center; }
.head .opt { flex: none; }
.opt.close { min-width: 32px; width: 32px; padding: 0; }
.opt.stock { margin-right: 6px; font-size: var(--ui-small); }
.opt.on { background: var(--accent); color: var(--accent-text); }
.opt.hover { box-shadow: inset 0 0 0 2px var(--ring); }
/* A switch (Gboard's style settings): the statement on the left, the switch at the right. */
.row.sw .name { flex: 1; width: auto; }
.switch { flex: none; position: relative; width: 46px; height: 26px; border-radius: var(--radius-pill); background: var(--mod); }
.switch::after { content: ''; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%;
  background: var(--legend); transition: left 0.12s; }
.switch.on { background: var(--accent); }
.switch.on::after { left: 23px; background: var(--accent-text); }
.switch.hover { box-shadow: 0 0 0 2px var(--ring); }
.about { color: var(--legend); font-size: var(--ui-caption); border-top: 1px solid var(--divider); padding-top: 3px; }
.about .err { color: var(--fn); }
`;

export interface SettingsView {
  hoverAt(x: number, y: number): boolean;
  setBounds(rect: { top: number; left: number; width: number; height: number }): void;
  destroy(): void;
}

export const createSettingsView = (
  doc: Document,
  shadow: ShadowRoot,
  theme: Theme,
  values: SettingsValues,
  info: SettingsInfo,
  { onTab, onChange, onOption, onStock, onClose, onLanguage, onKeyboards }: SettingsHandlers,
): SettingsView => {
  const style = doc.createElement('style');
  style.textContent = CSS + KEYBOARDS_CSS;
  const root = doc.createElement('div');
  root.className = 'panel';
  root.style.cssText = themeVars(theme) + sizeVars('normal');

  const actions = new Map<HTMLElement, () => void>();
  const guard = touchGuard(); // shared with the Keyboards page
  const option = (label: string, on: boolean, action: () => void, extra = ''): HTMLElement => {
    const el = doc.createElement('div');
    el.className = `opt${on ? ' on' : ''}${extra}`;
    if (label.startsWith('<svg')) el.innerHTML = label;
    else el.textContent = label;
    actions.set(el, action);
    return el;
  };
  const row = (name: string, ...options: HTMLElement[]): HTMLElement => {
    const el = doc.createElement('div');
    el.className = 'row';
    const label = doc.createElement('div');
    label.className = 'name';
    label.textContent = name;
    el.append(label, ...options);
    return el;
  };

  const head = doc.createElement('div');
  head.className = 'head';
  const title = doc.createElement('div');
  title.className = 'title';
  head.append(
    option('Settings', info.tab === 'general', () => onTab('general'), ' tab'),
    option('Keyboards', info.tab === 'keyboards', () => onTab('keyboards'), ' tab'),
    title,
    option('Steam keyboard', false, onStock, ' stock'), option(ICONS.hide, false, onClose, ' close'));

  /** A general on/off setting as a switch. */
  const onOff = (name: string, key: 'haptics' | 'suggestions'): HTMLElement => {
    const sw = doc.createElement('div');
    sw.className = `switch${values[key] ? ' on' : ''}`;
    actions.set(sw, () => onChange({ [key]: !values[key] }));
    const el = row(name, sw);
    el.classList.add('sw');
    return el;
  };

  const about = doc.createElement('div');
  about.className = 'about';
  about.textContent = `polykey ${info.version}`;
  for (const error of info.errors.slice(0, 3)) {
    const line = doc.createElement('div');
    line.className = 'err';
    line.textContent = error;
    about.append(line);
  }
  if (info.errors.length > 3) about.append(`… and ${info.errors.length - 3} more pack errors`);

  /** A switch row; tapping the switch flips it (an inverted option is stored the other way round). */
  const toggle = (o: SettingsInfo['options'][number]): HTMLElement => {
    const shown = o.invert ? !o.value : o.value;
    const sw = doc.createElement('div');
    sw.className = `switch${shown ? ' on' : ''}`;
    actions.set(sw, () => onOption(o.id, o.invert ? shown : !shown));
    const el = row(o.name, sw);
    el.classList.add('sw');
    return el;
  };
  const column = (heading: string, ...rows: HTMLElement[]): HTMLElement => {
    const el = doc.createElement('div');
    el.className = 'col';
    el.append(Object.assign(doc.createElement('div'), { className: 'sect', textContent: heading }), ...rows);
    return el;
  };
  const cols = doc.createElement('div');
  cols.className = 'cols';
  cols.append(
    column('General',
      row('Theme', ...info.themes.map((t) => option(t.name, t.id === values.theme, () => onChange({ theme: t.id })))),
      onOff('Haptics', 'haptics'),
      ...(info.suggestions ? [onOff('Suggestions', 'suggestions')] : [])),
    column(info.keyboardName,
      ...(info.options.length
        ? info.options.map((o) => (o.toggle ? toggle(o) : row(o.name, option(o.off, !o.value, () => onOption(o.id, false)),
          option(o.on, o.value, () => onOption(o.id, true)))))
        : [Object.assign(doc.createElement('div'), { className: 'none', textContent: 'No options for this keyboard.' })])),
  );
  if (info.tab === 'keyboards') {
    const hint = Object.assign(doc.createElement('div'), { className: 'hintline' });
    hint.append('Tap or drag a layout into your list · drag to reorder · drag out or ', inlineIcon(doc, 'hide'), ' to remove · hold ',
      inlineIcon(doc, 'globe'), ' to jump to one');
    root.append(head, buildKeyboardsPage(doc, info.keyboards, { onLanguage, onKeyboards }, actions, guard), hint);
  } else root.append(head, cols, about);

  const optionAt = (target: EventTarget | null): HTMLElement | undefined =>
    [...actions.keys()].find((el) => el === target || el.contains(target as Node));
  let hovered: HTMLElement | undefined;
  const setHover = (el: HTMLElement | undefined): boolean => {
    if (el === hovered) return false;
    hovered?.classList.remove('hover');
    hovered = el;
    el?.classList.add('hover');
    return true;
  };
  let pressed: HTMLElement | undefined;
  listenTouch(root, {
    start: (_p, e) => { pressed = optionAt(e.target); },
    move: () => {},
    end: () => {
      const hit = pressed;
      pressed = undefined;
      if (hit) actions.get(hit)?.();
    },
    click: (e) => {
      e.stopPropagation();
      const hit = optionAt(e.target);
      if (hit) actions.get(hit)?.();
    },
  }, { guard });
  root.addEventListener('mouseover', (e) => setHover(optionAt(e.target)));
  root.addEventListener('mousedown', (e) => e.stopPropagation());

  shadow.append(style, root);
  return {
    hoverAt: (x, y) => {
      const hits = typeof shadow.elementsFromPoint === 'function' ? shadow.elementsFromPoint(x, y) : [];
      return setHover(hits.map(optionAt).find(Boolean));
    },
    setBounds: ({ top, left, width, height }) => {
      Object.assign(root.style, { top: `${top}px`, left: `${left}px`, width: `${width}px`, height: `${height}px` });
    },
    destroy: () => { style.remove(); root.remove(); },
  };
};
