// The settings page, drawn in the keyboard area instead of the keys while open: theme, haptics,
// suggestions, and an About line. Changes apply at once through onChange; ✕ goes back to the keys.

import type { Theme } from '../core/catalog.js';
import { ICONS } from './icons.js';

export interface SettingsValues {
  theme: string;
  haptics: boolean;
  suggestions: boolean;
}

export interface SettingsInfo {
  themes: { id: string; name: string }[];
  version: string;
  errors: string[];
}

const CSS = `
.panel { position: fixed; box-sizing: border-box; display: flex; flex-direction: column; gap: 6px; padding: 6px 10px;
  background: var(--surface); color: var(--text); font: 400 15px/1.2 var(--font);
  pointer-events: auto; touch-action: none; user-select: none; -webkit-user-select: none; }
.head { display: flex; align-items: center; height: 26px; font-size: 16px; font-weight: 600; }
.head .title { flex: 1; }
.row { display: flex; align-items: center; gap: 8px; min-height: 34px; }
.row .name { width: 120px; color: var(--legend); }
.opt { display: flex; align-items: center; justify-content: center; min-width: 90px; height: 32px; padding: 0 12px;
  box-sizing: border-box; background: var(--mod); border-radius: var(--radius); }
.opt.close { min-width: 32px; width: 32px; padding: 0; }
.opt.on { background: var(--accent); color: var(--surface); }
.opt.hover { box-shadow: inset 0 0 0 2px var(--accent); }
.about { color: var(--legend); font-size: 13px; }
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
  onChange: (changes: Partial<SettingsValues>) => void,
  onClose: () => void,
): SettingsView => {
  const style = doc.createElement('style');
  style.textContent = CSS;
  const root = doc.createElement('div');
  root.className = 'panel';
  const c = theme.colors;
  root.style.cssText = `--surface:${c.surface};--text:${c.keyText};--mod:${c.modifier};--accent:${c.accent};`
    + `--legend:${c.legend ?? c.keyText};--fn:${c.fnLegend ?? c.accent};--radius:${theme.radius ?? 6}px;`
    + `--font:${theme.font ?? 'system-ui, sans-serif'};`;

  const actions = new Map<HTMLElement, () => void>();
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
  title.textContent = 'Settings';
  head.append(title, option(ICONS.hide, false, onClose, ' close'));

  const onOff = (key: 'haptics' | 'suggestions') => [
    option('On', values[key], () => onChange({ [key]: true })),
    option('Off', !values[key], () => onChange({ [key]: false })),
  ];

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

  root.append(
    head,
    row('Theme', ...info.themes.map((t) => option(t.name, t.id === values.theme, () => onChange({ theme: t.id })))),
    row('Haptics', ...onOff('haptics')),
    row('Suggestions', ...onOff('suggestions')),
    about,
  );

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
  let lastTouchAt = -Infinity;
  root.addEventListener('touchstart', (e) => {
    e.preventDefault();
    e.stopPropagation();
    pressed = optionAt(e.target);
  }, { passive: false });
  root.addEventListener('touchmove', (e) => { e.preventDefault(); e.stopPropagation(); }, { passive: false });
  root.addEventListener('touchend', (e) => {
    e.preventDefault();
    e.stopPropagation();
    lastTouchAt = Date.now();
    const hit = pressed;
    pressed = undefined;
    if (hit) actions.get(hit)?.();
  }, { passive: false });
  root.addEventListener('mouseover', (e) => setHover(optionAt(e.target)));
  root.addEventListener('mousedown', (e) => e.stopPropagation());
  root.addEventListener('click', (e) => {
    e.stopPropagation();
    if (Date.now() - lastTouchAt < 600) return;
    const hit = optionAt(e.target);
    if (hit) actions.get(hit)?.();
  });

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
