// Settings → Dictation: the switch, then (while on) languages on the left, the models for that language,
// or the downloaded ones, in the middle, and the switches and the engine on the right. Tap a model to use
// it for the language, downloading it first if needed; ✕ deletes it (or stops its download); ⓘ (hovered
// with the laser, or tapped) shows its details and licence. The keyboard's language picks among the
// downloaded models when dictating (core/dictation.ts, modelFor). The columns scroll like every settings
// list (.scroll). settings.ts lends its row, option and switch builders and handles taps and
// laser hover through `actions`.

import {
  ANY_LANGUAGE, gradeFor, modelFor, serves, speedBars,
  type FileState, type SpeechCatalog, type SpeechModel, type SpeechStatus,
} from '../core/dictation.js';
import { ICONS, INFO_ICON, signalBars } from './icons.js';
import { languageName, pageColumn } from './keyboards-page.js';

export interface DictationInfo {
  /** null until the sidecar answers. */
  catalog: SpeechCatalog | null;
  status: SpeechStatus | null;
  /** The keyboards' languages (dictationLanguages). */
  languages: string[];
  /** The language whose models are shown, or DOWNLOADED for what is on disk. */
  language: string;
}

export interface DictationHandlers {
  onSpeechLanguage(code: string): void;
  /** Use this model for the language (the page downloads it too when it is missing). */
  onChoose(language: string, modelId: string): void;
  /** Download the engine, and the model if named. */
  onDownload(modelId?: string): void;
  onDelete(modelId: string): void;
}

// A model row: name, grade, speed, state, ⓘ, ✕ — fixed columns, so every row lines up and ✕ ends it.
// A download's progress along the row's foot, like the mic key's: a fill, or a moving stripe until it starts.
// ⓘ's details: inside the panel, never scrolling it.
export const DICTATION_CSS = `
.dm .col.langs { flex: 0 0 19%; }
.dm .col.models { flex: 0 0 47%; }
.dm .models .item, .dm .colhead { display: grid; grid-template-columns: minmax(0, 1fr) 28px 40px 70px 20px 22px; gap: 4px;
  position: relative; padding-right: 2px; }
.dm .models.dl .item, .dm .models.dl .colhead { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr) 70px 20px 22px; }
.dm .models.dl .colhead > div:nth-child(2) { justify-self: start; }
.dm .models.dl .colhead > div:nth-child(3) { justify-self: end; }
.dm .item .used { overflow: hidden; text-overflow: ellipsis; color: var(--legend); font-size: var(--ui-small); }
.dm .item .used.none { opacity: var(--opacity-muted); }
.dm .dlsect { flex: none; margin-top: 3px; padding-top: 4px; border-top: 1px solid var(--divider); }
.dm .sect.colhead { padding-left: 0; box-sizing: border-box; }
.dm .colhead > div { justify-self: center; }
.dm .colhead > div:first-child { justify-self: start; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.dm .colhead > div:nth-child(4) { justify-self: end; }
.dm .item .grade { justify-self: center; min-width: 22px; padding: 1px 3px; box-sizing: border-box; border-radius: var(--radius-sm);
  background: var(--surface); color: var(--text); font-size: var(--ui-small); font-weight: 600; text-align: center; line-height: 1.25; }
.dm .item .speed { display: flex; justify-content: center; color: var(--text); font-size: var(--ui-small); }
.dm .item .mark { justify-self: end; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm .item.sel .mark, .dm .item.added .mark { color: var(--accent); }
.dm .item .mark.fail { color: var(--fn); }
.dm .ic.i, .dm .item .x { width: 20px; height: 22px; display: flex; align-items: center; justify-content: center;
  border-radius: var(--radius); color: var(--legend); font-size: var(--ui-control); }
.dm .item .x { width: 22px; }
.dm .ic.i.hover, .dm .ic.i.open { background: var(--accent); color: var(--accent-text); }
.dm .dlbar { position: absolute; left: 6px; right: 6px; bottom: 1px; height: 2px; border-radius: 1px; overflow: hidden;
  pointer-events: none; background: color-mix(in srgb, currentColor 25%, transparent); }
.dm .dlbar i { display: block; height: 100%; width: 0; background: var(--accent); transition: width 0.3s ease-out; }
.dm .dlbar.wait i { width: 30%; animation: dm-wait 1.2s ease-in-out infinite alternate; }
@keyframes dm-wait { from { transform: translateX(-10%); } to { transform: translateX(243%); } }
@media (prefers-reduced-motion: reduce) {
  .dm .dlbar i { transition: none; }
  .dm .dlbar.wait i { animation: none; width: 100%; opacity: 0.5; }
}
.dm .speech .list { gap: 2px; }
.dm .row.engine { position: relative; }
.dm .note, .dm-off .note { color: var(--legend); font-size: var(--ui-small); }
.dm .row .note { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm .note.detail { margin: -2px 0 4px; }
.dm .opt.dl { flex: none; }
.dm-off { flex: 1; display: flex; flex-direction: column; gap: 4px; max-width: 60%; }
.dm-pop { position: absolute; z-index: 4; box-sizing: border-box; padding: 5px 8px; overflow: hidden; pointer-events: none;
  background: var(--key); background-image: linear-gradient(var(--raised), var(--raised)); color: var(--text);
  border-radius: var(--radius); box-shadow: var(--shadow-lg); font-size: var(--ui-small); line-height: 1.3; }
.dm-pop .t { font-weight: 600; margin-bottom: 2px; }
.dm-pop p { margin: 0 0 2px; }
.dm-pop .bench { color: var(--legend); }
`;

/** The ⓘ popover's widest, and the least room it needs left of its ⓘ before it goes to the right instead. */
const POP_PX = 360;
const POP_MIN_PX = 200;

const mb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1e6))} MB`;
const size = (bytes: number): string => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : mb(bytes));
/** The Downloaded entry, in place of a language. */
const DOWNLOADED = 'downloaded';
const share = (s: FileState): number => (s.state === 'downloading' ? s.done / Math.max(1, s.total) : 0);
const percent = (s: FileState): string => `${Math.floor(share(s) * 100)}%`;
/** Failures in words; other codes are shown as they are. */
const FAILURES: Record<string, string> = {
  network: 'no connection', 'no-space': 'not enough disk space', 'bad-hash': 'file did not verify', 'bad-size': 'file did not verify',
  unsupported: 'no engine for this CPU', 'bad-archive': 'engine archive did not unpack',
};
const failure = (code: string): string => FAILURES[code] ?? code;

/** The engine's line: its state, or why its download failed. */
const engineText = (catalog: SpeechCatalog | null, status: SpeechStatus | null): string => {
  if (!status || !catalog) return 'Checking the speech engine…';
  const e = status.engine;
  if (e.state === 'ready') return `transcribe.cpp ${catalog.engine.version}`;
  if (e.state === 'downloading') return `Downloading the speech engine: ${percent(e)}`;
  return e.error ? `Engine download failed: ${failure(e.error)}` : `Needs the speech engine (${mb(catalog.engine.size)})`;
};

/** A model's state: in use, downloaded, its progress, retry after a failure, or its size. */
const markText = (model: SpeechModel, state: FileState | undefined, inUse: boolean): string =>
  state?.state === 'ready' ? (inUse ? '✓ in use' : '✓') : state?.state === 'downloading' ? percent(state)
    : state?.error ? 'retry' : mb(model.size);

/** What decides the page's layout (not progress): when it changes the page is drawn again. */
const shape = (status: SpeechStatus | null): string =>
  JSON.stringify(status && [status.engine.state, Object.entries(status.models).map(([id, s]) => [id, s.state, 'error' in s ? s.error : '']), status.choices]);

/** Licence ids as people know them; the full attribution, with links, is in catalog.json and the README. */
const LICENCES: Record<string, string> = { 'CC-BY-4.0': 'CC BY 4.0', 'FunASR-1.1': 'FunASR Model License 1.1' };
const ram = (mb: number): string => (mb >= 1000 ? `~${(mb / 1000).toFixed(mb % 1000 ? 1 : 0)} GB RAM` : `~${mb} MB RAM`);

/** A model's details for its ⓘ, a few short lines: what it covers and needs, its notes, licence and credit, Handy's numbers. */
const modelDetails = (model: SpeechModel, state: FileState | undefined, language: string): [string, string][] => {
  const languages = model.languages.includes(ANY_LANGUAGE) ? 'Any language'
    : model.languages.length > 3 ? `${model.languages.length} languages` : model.languages.map(languageName).join(', ');
  const rtf = model.handy.cpuRtf;
  const error = model.handy.error?.[language];
  return [
    ['', `${languages} · ${mb(model.size)} · ${ram(model.ramMB)}`],
    ['', model.notes],
    ['', `${LICENCES[model.licence] ?? model.licence} · ${model.credit}`],
    ['bench', `Handy, not the Frame: ${rtf ? `30 s in ${(30 / rtf).toFixed(1)} s` : 'speed unknown'}`
      + `${error !== undefined ? ` · ${language.toUpperCase()} error ${error.toFixed(1)}%` : ''}`],
    ...(state?.state === 'missing' && state.error ? [['', `Last download failed: ${failure(state.error)}.`] as [string, string]] : []),
  ];
};

export interface DictationPage {
  root: HTMLElement;
  /** A new status: shown in place; false when the page must be drawn again. */
  setStatus(status: SpeechStatus | null): boolean;
  /** What the laser (or mouse) is over now, from settings' hover path: an ⓘ opens its details. */
  hover(el: HTMLElement | undefined): void;
}

export const buildDictationPage = (
  doc: Document,
  info: DictationInfo,
  handlers: DictationHandlers,
  { row, option, dictationSwitch, continuousSwitch }: {
    row: (name: string, ...options: HTMLElement[]) => HTMLElement;
    option: (label: string, on: boolean, action: () => void, extra?: string) => HTMLElement;
    /** The Dictation on/off row. */
    dictationSwitch: HTMLElement;
    /** The Continuous dictation row. */
    continuousSwitch: HTMLElement;
  },
  actions: Map<HTMLElement, () => void>,
  enabled: boolean,
): DictationPage => {
  const el = (cls: string, text = ''): HTMLElement => Object.assign(doc.createElement('div'), { className: cls, textContent: text });
  const { catalog, status } = info;

  if (!enabled) {
    const root = el('dm-off');
    root.append(dictationSwitch,
      el('note', 'Speech is recognized on the Frame, on its CPU: no audio leaves it, and nothing is logged or saved. '
        + 'Nothing is downloaded or run until this is on; then the speech engine (about 18 MB) downloads, and you pick a model per language.'));
    return { root, setStatus: () => true, hover: () => {} };
  }

  const root = el('kbs dm');
  const column = (cls: string, heading: string) => pageColumn(root, cls, heading);
  const inUse = (language: string): SpeechModel | undefined => (catalog && status ? modelFor(catalog, status, language) : undefined);

  // ⓘ: details in a popover over the panel, opened by hovering it or by a tap (touch has no hover).
  const details = new Map<HTMLElement, () => [string, string][]>();
  const pop = el('dm-pop');
  let pinned: HTMLElement | undefined;
  let shown: HTMLElement | undefined;
  const infoIcon = (title: string, lines: () => [string, string][]): HTMLElement => {
    const icon = Object.assign(el('ic i'), { innerHTML: INFO_ICON });
    details.set(icon, () => [['t', title], ...lines()]);
    actions.set(icon, () => {
      pinned = pinned === icon ? undefined : icon;
      show(pinned);
    });
    return icon;
  };
  const show = (icon: HTMLElement | undefined): void => {
    shown?.classList.remove('open');
    shown = icon;
    const panel = root.parentElement;
    if (!icon || !panel) {
      pop.remove();
      return;
    }
    icon.classList.add('open');
    pop.replaceChildren(...(details.get(icon)?.() ?? []).filter(([, text]) => text)
      .map(([cls, text]) => Object.assign(doc.createElement(cls === 't' ? 'div' : 'p'), { className: cls, textContent: text })));
    panel.append(pop);
    // Beside the ⓘ, left of it (right of it if there is no room), so it never covers the ⓘ and ✕ columns
    // and the laser can go on to the next ⓘ; level with it, moved up as far as it must to stay in the panel.
    const box = panel.getBoundingClientRect();
    const at = icon.getBoundingClientRect();
    const room = at.left - box.left - 8;
    const leftSide = room >= POP_MIN_PX;
    // At most the models column's width, and half the panel's height.
    const width = Math.min(POP_PX, list.col.getBoundingClientRect().width || POP_PX, leftSide ? room : box.right - at.right - 8);
    pop.style.width = `${width}px`;
    pop.style.maxHeight = `${Math.round(box.height / 2)}px`;
    const height = pop.offsetHeight;
    pop.style.top = `${Math.max(4, Math.min(at.top - box.top - 4, box.height - height - 4))}px`;
    pop.style.left = `${leftSide ? at.left - box.left - 4 - width : at.right - box.left + 4}px`;
  };
  // A tap anywhere but on an ⓘ closes what a tap opened.
  const closeOnTap = (e: Event): void => {
    if (pinned && ![...details.keys()].some((icon) => icon.contains(e.target as Node))) {
      pinned = undefined;
      show(undefined);
    }
  };
  for (const type of ['touchstart', 'mousedown'] as const) root.addEventListener(type, closeOnTap, { capture: true, passive: true });

  // A download's bar along a row's foot: its share, or a moving stripe until bytes arrive.
  const downloadBar = (into: HTMLElement): ((state: FileState | undefined) => void) => {
    const bar = el('dlbar');
    const fill = bar.appendChild(doc.createElement('i'));
    return (state) => {
      if (state?.state !== 'downloading') {
        bar.remove();
        return;
      }
      if (!bar.parentElement) into.append(bar);
      bar.classList.toggle('wait', state.done === 0);
      fill.style.width = state.done ? `${(share(state) * 100).toFixed(1)}%` : '';
    };
  };

  // Languages: your keyboards' (a choice for one whose keyboard went stays in settings, for its return);
  // ✓ where a downloaded model serves it. Below them, outside their scroller, Downloaded: what is on disk.
  const langs = column('langs', 'Languages');
  for (const code of info.languages) {
    const item = el(code === info.language ? 'item sel' : 'item');
    item.append(el('nm', languageName(code)), el('mark', inUse(code) ? '✓' : ''));
    actions.set(item, () => handlers.onSpeechLanguage(code));
    langs.list.append(item);
  }
  const onDisk = catalog?.models.filter((m) => ['ready', 'downloading'].includes(status?.models[m.id]?.state ?? '')) ?? [];
  const downloaded = el(info.language === DOWNLOADED ? 'item sel' : 'item');
  downloaded.append(el('nm', 'Downloaded'), el('mark', onDisk.length ? String(onDisk.length) : ''));
  actions.set(downloaded, () => handlers.onSpeechLanguage(DOWNLOADED));
  const section = el('dlsect');
  section.append(downloaded);
  langs.col.append(section);

  /** Your languages that dictate with `model` now. */
  const usedFor = (model: SpeechModel): string[] => info.languages.filter((code) => inUse(code) === model).map(languageName);
  /** A model's state cell: in use, downloaded, its progress, retry, or its size. */
  const stateCell = (model: SpeechModel, inUseHere: boolean): { cell: HTMLElement; show: (state: FileState | undefined) => void } => {
    const cell = el('mark');
    return {
      cell,
      show: (state) => {
        cell.textContent = markText(model, state, inUseHere);
        cell.classList.toggle('fail', state?.state === 'missing' && !!state.error);
      },
    };
  };
  const updates = new Map<string, (state: FileState | undefined) => void>();
  /** A row's ✕ (delete, or stop the download), or an empty cell; set before the row, so a tap on it is its own. */
  const deleteCell = (model: SpeechModel, state: FileState | undefined): HTMLElement => {
    const x = state?.state === 'ready' || state?.state === 'downloading' ? Object.assign(el('x'), { innerHTML: ICONS.hide }) : el('x');
    if (x.innerHTML) actions.set(x, () => handlers.onDelete(model.id));
    return x;
  };
  /** The column's title line on the rows' grid: the title, then labels over their columns; it stays as the list scrolls. */
  const titleLine = (col: HTMLElement, title: string, ...labels: string[]): void => {
    const head = col.firstElementChild as HTMLElement;
    head.classList.add('colhead');
    head.replaceChildren(el('', title), ...labels.map((label) => el('', label)));
  };

  const language = info.language;
  let list: { col: HTMLElement; list: HTMLElement };
  if (language === DOWNLOADED) {
    // Everything on disk (and on its way): which of your languages use it, its size, ⓘ and ✕. Nothing is
    // ever deleted but by ✕.
    list = column('models dl', 'Downloaded');
    const total = onDisk.filter((m) => status?.models[m.id]?.state === 'ready').reduce((sum, m) => sum + m.size, 0);
    titleLine(list.col, total ? `Downloaded · ${size(total)}` : 'Downloaded', 'Used for', 'Size');
    for (const model of onDisk) {
      const state = status?.models[model.id];
      const item = el('item');
      const used = usedFor(model);
      const { cell, show } = stateCell(model, false);
      const bar = downloadBar(item);
      const update = (next: FileState | undefined): void => { show(next); bar(next); };
      update(state);
      updates.set(model.id, update);
      const x = deleteCell(model, state);
      item.append(el('nm', model.name), el(used.length ? 'used' : 'used none', used.length ? used.join(', ') : 'not used'), cell,
        infoIcon(model.name, () => modelDetails(model, status?.models[model.id], 'en')), x);
      list.list.append(item);
    }
    if (!onDisk.length) list.list.append(el('note detail', 'Nothing downloaded yet.'));
  } else {
    // The language's models, those made for it first, then those for any language: this language's grade,
    // speed bars, state, ⓘ and ✕.
    const current = inUse(language);
    const models = catalog?.models.filter((m) => serves(m, language)) ?? [];
    models.sort((a, b) => Number(a.languages.includes(ANY_LANGUAGE)) - Number(b.languages.includes(ANY_LANGUAGE)));
    list = column('models', `${languageName(language)} models`);
    titleLine(list.col, `${languageName(language)} models`, language.toUpperCase(), 'Speed', 'Size');
    for (const model of models) {
      const state = status?.models[model.id];
      const item = el(model === current ? 'item sel' : state?.state === 'ready' ? 'item added' : 'item');
      const { cell, show } = stateCell(model, model === current);
      const bar = downloadBar(item);
      const update = (next: FileState | undefined): void => { show(next); bar(next); };
      update(state);
      updates.set(model.id, update);
      const grade = gradeFor(model, language);
      const x = deleteCell(model, state);
      item.append(el('nm', model.name), el(grade ? 'grade' : '', grade), Object.assign(el('speed'), { innerHTML: signalBars(speedBars(model)) }),
        cell, infoIcon(model.name, () => modelDetails(model, status?.models[model.id], language)), x);
      actions.set(item, () => {
        if (state?.state === 'downloading') return;
        handlers.onChoose(language, model.id);
        if (state?.state !== 'ready') handlers.onDownload(model.id);
      });
      list.list.append(item);
    }
    if (!catalog) list.list.append(el('note', 'Asking the sidecar for the models…'));
    else if (!current) list.list.append(el('note detail', `No ${languageName(language)} model downloaded yet: tap one.`));
  }

  // The switches, the engine (with its credit), and where dictated Japanese goes.
  const about = column('speech', 'Dictation');
  const engineNote = el('note');
  const retry = option('Download', false, () => handlers.onDownload(), ' dl');
  const engineRow = row('Engine', engineNote, retry, infoIcon('Speech engine', () => [
    ['', catalog ? `transcribe.cpp ${catalog.engine.version} · ${mb(catalog.engine.size)} · CPU only` : ''],
    ['', catalog?.engine.attribution ?? ''],
  ]));
  engineRow.classList.add('engine');
  const engineBar = downloadBar(engineRow);
  const showEngine = (next: SpeechStatus | null): void => {
    engineNote.textContent = engineText(catalog, next);
    retry.textContent = next?.engine.state === 'missing' && next.engine.error ? 'Retry' : 'Download';
    retry.style.display = next?.engine.state === 'missing' ? '' : 'none';
    engineBar(next?.engine);
  };
  showEngine(status);
  about.list.append(dictationSwitch, continuousSwitch, el('note detail', 'Pauses type what you said. Tap the mic to stop.'),
    engineRow);

  let built = shape(status);
  return {
    root,
    setStatus: (next) => {
      if (shape(next) !== built) return false; // a model came or went: the caller draws the page again
      built = shape(next);
      showEngine(next);
      for (const [id, update] of updates) update(next?.models[id]);
      return true;
    },
    hover: (target) => {
      if (pinned) return; // a tapped ⓘ stays open until the next tap
      show(target && details.has(target) ? target : undefined);
    },
  };
};
