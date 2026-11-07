// The settings page, drawn in the keyboard area instead of the keys while open. Three tabs: Settings has
// General (theme, haptics, suggestions, automatic updates) on the left, the current keyboard's own
// options on the right, and the version, its update line (src/updates.ts) and any pack errors at the
// bottom; Keyboards picks and orders the keyboards 🌐 goes
// through (ui/keyboards-page.ts); Dictation turns it on and picks its models (ui/dictation-page.ts).
// Changes apply at once; ✕ goes back to the keys, and "Steam keyboard" hands over to Steam's own (🌐
// skips it).

import type { Theme } from '../core/catalog.js';
import { SLOP_PX, touchGuard } from '../core/interaction.js';
import { dragScroll, listenTouch, type DragScroll } from './gesture.js';
import { ICONS, INFO_ICON } from './icons.js';
import { sizeVars } from './sizes.js';
import { themeVars } from './theme.js';
import { THEME_PICKER_CSS, buildThemePicker, type ThemeChoice } from './theme-picker.js';
import { KEYBOARDS_CSS, buildKeyboardsPage, inlineIcon, pageColumn, type KeyboardsHandlers, type KeyboardsInfo } from './keyboards-page.js';
import { DICTATION_CSS, buildDictationPage, type DictationHandlers, type DictationInfo, type DictationPage } from './dictation-page.js';
import { INFO_CSS } from './info.js';
import type { SpeechStatus } from '../core/dictation.js';
import { updateSummary, type UpdateAction, type UpdateStatus } from '../updates.js';

export type SettingsTab = 'general' | 'keyboards' | 'dictation';

export interface SettingsValues {
  theme: string;
  haptics: boolean;
  suggestions: boolean;
  dictation: boolean;
  /** Pauses type each phrase and listening goes on until the mic is pressed again. */
  dictationContinuous: boolean;
  /** Install a newer release when one is found (off: checks only report). */
  autoUpdate: boolean;
}

export interface SettingsInfo {
  themes: ThemeChoice[];
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
  /** The Dictation tab's models and their state. */
  dictation?: DictationInfo;
  /** The updater's status, for the line under the version (null until the sidecar answers). */
  update?: UpdateStatus | null;
}

export interface SettingsHandlers extends KeyboardsHandlers, Partial<DictationHandlers> {
  onTab(tab: SettingsTab): void;
  onChange(changes: Partial<SettingsValues>): void;
  onOption(id: string, value: boolean): void;
  onStock(): void;
  onClose(): void;
  onUpdate(action: UpdateAction): void;
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
.col > .list { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 4px; }
.col > .list > * { flex: none; }
/* Whatever can outgrow its place scrolls the same way on every tab: natively, with no bars, and dragged
   with a finger or the trigger (the panel's dragScroll). */
.scroll { overflow-y: auto; overscroll-behavior: contain; scrollbar-width: none; }
.scroll::-webkit-scrollbar { display: none; }
.sect { font-size: var(--ui-caption); font-weight: 600; letter-spacing: 0.04em; color: var(--legend);
  border-bottom: 1px solid var(--divider); padding-bottom: 3px; margin-bottom: 1px; white-space: nowrap; overflow: hidden; }
.none { color: var(--legend); font-size: var(--ui-small); padding-top: 4px; }
.row { display: flex; align-items: center; gap: 6px; min-height: var(--row-height); }
.row .name { flex: none; width: 104px; color: var(--text); font-size: var(--ui-control); }
.opt { flex: 1 1 0; min-width: 0; display: flex; align-items: center; justify-content: center; min-height: var(--row-height); padding: 2px 8px;
  box-sizing: border-box; background: var(--mod); border-radius: var(--radius); font-size: var(--ui-control); line-height: 1.1;
  text-align: center; }
.head .opt { flex: none; }
.opt.close { min-width: 32px; width: 32px; padding: 0; margin-right: 10px; }
.opt.stock { font-size: var(--ui-small); }
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
/* ⓘ after a row's name, a laser-sized target: a tap shows or hides one line under the row. */
.row .name:has(> .info) { display: flex; align-items: center; }
.ic.info { align-items: center; justify-content: center; width: 32px; height: var(--row-height); margin-left: 4px;
  border-radius: var(--radius); color: var(--legend); }
.ic.info.hover { box-shadow: inset 0 0 0 2px var(--ring); }
.ic.info.open { background: var(--accent); color: var(--accent-text); }
.info-line { margin: -2px 0 2px; color: var(--legend); font-size: var(--ui-small); }
.about { color: var(--legend); font-size: var(--ui-caption); border-top: 1px solid var(--divider); padding-top: 3px; }
.about .err { color: var(--error); }
.about .ver { display: flex; align-items: center; gap: 8px; min-height: 24px; }
.about .ver > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.about .opt.small { flex: none; min-height: 22px; padding: 1px 10px; font-size: var(--ui-caption); color: var(--text); }
`;

export interface SettingsView {
  hoverAt(x: number, y: number): boolean;
  setBounds(rect: { top: number; left: number; width: number; height: number }): void;
  /** Show a new dictation.status (download progress) in place; false when the page must be drawn again. */
  setDictation(status: SpeechStatus | null): boolean;
  /** Show the updater's new status in place. */
  setUpdate(status: UpdateStatus | null): void;
  destroy(): void;
}

export const createSettingsView = (
  doc: Document,
  shadow: ShadowRoot,
  theme: Theme,
  values: SettingsValues,
  info: SettingsInfo,
  { onTab, onChange, onOption, onStock, onClose, onUpdate, onLanguage, onKeyboards, ...speech }: SettingsHandlers,
): SettingsView => {
  const style = doc.createElement('style');
  style.textContent = CSS + KEYBOARDS_CSS + THEME_PICKER_CSS + DICTATION_CSS + INFO_CSS;
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
    option(ICONS.back, false, onClose, ' close'),
    option('Settings', info.tab === 'general', () => onTab('general'), ' tab'),
    option('Keyboards', info.tab === 'keyboards', () => onTab('keyboards'), ' tab'),
    option('Dictation', info.tab === 'dictation', () => onTab('dictation'), ' tab'),
    title,
    option('Steam keyboard', false, onStock, ' stock'));

  /** A general on/off setting as a switch. */
  const onOff = (name: string, key: 'haptics' | 'suggestions' | 'dictation' | 'dictationContinuous' | 'autoUpdate'): HTMLElement => {
    const sw = doc.createElement('div');
    sw.className = `switch${values[key] ? ' on' : ''}`;
    actions.set(sw, () => onChange({ [key]: !values[key] }));
    const el = row(name, sw);
    el.classList.add('sw');
    return el;
  };
  /** A row with ⓘ after its name: a tap shows or hides `text` on a line under it (the laser has no hover). */
  const explained = (el: HTMLElement, text: string): HTMLElement[] => {
    const line = Object.assign(doc.createElement('div'), { className: 'info-line', textContent: text, hidden: true });
    const icon = Object.assign(doc.createElement('span'), { className: 'ic info', innerHTML: INFO_ICON });
    actions.set(icon, () => {
      line.hidden = !line.hidden;
      icon.classList.toggle('open', !line.hidden);
    });
    el.querySelector('.name')?.append(icon);
    return [el, line];
  };

  const about = doc.createElement('div');
  about.className = 'about';
  // The version, what the updater says, and its buttons (Check, Install, Back).
  const versionLine = doc.createElement('div');
  versionLine.className = 'ver';
  const drawUpdate = (status: UpdateStatus | null): void => {
    for (const el of versionLine.querySelectorAll<HTMLElement>('.opt')) actions.delete(el);
    const { text, actions: buttons } = updateSummary(status);
    const label = doc.createElement('span');
    label.textContent = `polykey ${info.version}${text ? ` · ${text}` : ''}`;
    versionLine.replaceChildren(label, ...buttons.map((b) => option(b.label, false, () => onUpdate(b.action), ' small')));
  };
  drawUpdate(info.update ?? null);
  about.append(versionLine);
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
  const themes = buildThemePicker(doc, info.themes, values.theme, (theme) => onChange({ theme }), actions);
  const cols = doc.createElement('div');
  cols.className = 'cols';
  pageColumn(cols, 'general', 'General').list.append(
    row('Theme', themes.el),
    onOff('Haptics', 'haptics'),
    ...(info.suggestions ? [onOff('Suggestions', 'suggestions')] : []),
    ...explained(onOff('Update automatically', 'autoUpdate'), 'Checks at start and hourly; installs when the keyboard closes.'));
  pageColumn(cols, 'options', info.keyboardName).list.append(
    ...(info.options.length
      ? info.options.map((o) => (o.toggle ? toggle(o) : row(o.name, option(o.off, !o.value, () => onOption(o.id, false)),
        option(o.on, o.value, () => onOption(o.id, true)))))
      : [Object.assign(doc.createElement('div'), { className: 'none', textContent: 'No options for this keyboard.' })]));
  let dictationPage: DictationPage | undefined;
  if (info.tab === 'keyboards') {
    const hint = Object.assign(doc.createElement('div'), { className: 'hintline' });
    hint.append('Tap or drag a layout into your list · drag to reorder · drag out or ', inlineIcon(doc, 'close'), ' to remove · hold ',
      inlineIcon(doc, 'globe'), ' to jump to one');
    root.append(head, buildKeyboardsPage(doc, info.keyboards, { onLanguage, onKeyboards }, actions, guard), hint);
  } else if (info.tab === 'dictation' && info.dictation) {
    const none = (): void => {};
    dictationPage = buildDictationPage(doc, info.dictation, { onSpeechLanguage: none, onChoose: none, onDownload: none, onDelete: none, ...speech },
      { row, option, dictationSwitch: onOff('Dictation', 'dictation'), continuousSwitch: onOff('Continuous dictation', 'dictationContinuous') },
      actions, values.dictation);
    const hint = Object.assign(doc.createElement('div'), { className: 'hintline' });
    hint.append(values.dictation
      ? 'Tap a model to use it for the language (it downloads first) · ✕ deletes it · speed and accuracy are Handy\'s benchmarks, not measured on the Frame'
      : 'The mic key on the toolbar dictates once this is on');
    root.append(head, dictationPage.root, hint);
  } else root.append(head, cols, about);

  const optionAt = (target: EventTarget | null): HTMLElement | undefined =>
    [...actions.keys()].find((el) => el === target || el.contains(target as Node));
  let hovered: HTMLElement | undefined;
  const setHover = (el: HTMLElement | undefined): boolean => {
    if (el === hovered) return false;
    hovered?.classList.remove('hover');
    hovered = el;
    el?.classList.add('hover');
    dictationPage?.hover(el); // its ⓘ show their details while hovered
    return true;
  };
  /** The list a press drags: the innermost .scroll that overflows, else the innermost (nothing to move). */
  const scrollerAt = (target: EventTarget | null): HTMLElement | undefined => {
    const lists: HTMLElement[] = [];
    for (let n = target as HTMLElement | null; n && n !== root; n = n.parentElement) if (n.classList?.contains('scroll')) lists.push(n);
    return lists.find((l) => l.scrollHeight > l.clientHeight) ?? lists[0];
  };
  let pressed: HTMLElement | undefined;
  let drag: DragScroll | undefined;
  listenTouch(root, {
    start: (p, e) => {
      pressed = optionAt(e.target);
      const list = p ? scrollerAt(e.target) : undefined;
      drag = list && p ? dragScroll(list, p, 'y', SLOP_PX.list) : undefined;
      themes.start(e.target);
    },
    move: (p) => { if (p) drag?.move(p); },
    end: () => {
      const hit = pressed;
      const scrolled = drag?.moved ?? false;
      pressed = undefined;
      drag = undefined;
      if (scrolled) return; // a drag past the slop scrolls and never taps
      if (themes.end()) return; // a tap outside the open theme list closed it
      if (hit) actions.get(hit)?.();
    },
    cancel: () => { pressed = undefined; drag = undefined; },
    click: (e) => {
      e.stopPropagation();
      if (themes.end(e.target)) return;
      const hit = optionAt(e.target);
      if (hit) actions.get(hit)?.();
    },
  }, { guard });
  root.addEventListener('mouseover', (e) => setHover(themes.reaches(e.target) ? optionAt(e.target) : undefined));
  root.addEventListener('mousedown', (e) => e.stopPropagation());

  shadow.append(style, root);
  return {
    hoverAt: (x, y) => {
      const hits = typeof shadow.elementsFromPoint === 'function' ? shadow.elementsFromPoint(x, y) : [];
      return setHover(hits.filter(themes.reaches).map(optionAt).find(Boolean));
    },
    setBounds: ({ top, left, width, height }) => {
      Object.assign(root.style, { top: `${top}px`, left: `${left}px`, width: `${width}px`, height: `${height}px` });
    },
    setDictation: (status) => dictationPage?.setStatus(status) ?? true,
    setUpdate: (status) => drawUpdate(status),
    destroy: () => { style.remove(); root.remove(); },
  };
};
