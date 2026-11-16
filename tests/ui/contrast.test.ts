// @vitest-environment jsdom
// Text stays readable in every state, in every bundled theme: what the views' CSS paints, read back through
// jsdom's cascade, held to WCAG AA (4.5:1) against what is painted behind it. Legends, the Fn colour on
// the Fn key at rest and the best suggestion's accent are the theme's own colours for text, not a state's,
// so they are not held to it here.
import { describe, expect, it } from 'vitest';
import type { Theme } from '../../src/core/catalog.js';
import { NO_EMOJI_STATE, toneTable } from '../../src/core/emoji.js';
import { NO_MODS, type Mods } from '../../src/core/keyboard.js';
import { createEmojiView } from '../../src/ui/emoji.js';
import { createSettingsView } from '../../src/ui/settings.js';
import { createView } from '../../src/ui/view.js';
import { bundledBoot, emojiSet } from '../boot.js';

const boot = bundledBoot();
const themes = Object.values(boot.catalog.themes);

/** A computed colour (#rrggbb, #rrggbbaa, rgb() or rgba()) as sRGB channels 0..1 and an alpha. */
const parse = (css: string): { rgb: number[]; alpha: number } => {
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(css);
  if (hex) {
    const n = (s: string, i: number) => parseInt(s.slice(i, i + 2), 16) / 255;
    return { rgb: [0, 2, 4].map((i) => n(hex[1]!, i)), alpha: hex[2] ? n(hex[2], 0) : 1 };
  }
  const fn = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(css);
  if (!fn) throw new Error(`not a colour: ${css}`);
  return { rgb: [fn[1], fn[2], fn[3]].map((v) => Number(v) / 255), alpha: fn[4] === undefined ? 1 : Number(fn[4]) };
};
const over = (top: { rgb: number[]; alpha: number }, under: number[]) => top.rgb.map((v, i) => v * top.alpha + under[i]! * (1 - top.alpha));
const luminance = (c: number[]) => {
  const [r, g, b] = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: number[], b: number[]) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const hex = (c: number[]) => `#${c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;

/** jsdom keeps a `background` shorthand holding var() uncomputed; a lone colour sets only background-color, so say so. */
const longhandBackgrounds = (shadow: ShadowRoot): void => {
  for (const style of shadow.querySelectorAll('style')) {
    for (const rule of [...(style.sheet?.cssRules ?? [])] as CSSStyleRule[]) {
      const bg = rule.style?.getPropertyValue('background').trim();
      if (!bg || !/^(var\(--[\w-]+\)|none)$/.test(bg)) continue;
      rule.style.removeProperty('background');
      rule.style.setProperty('background-color', bg === 'none' ? 'transparent' : bg);
    }
  }
};

/**
 * The colours `el`'s text and the background behind it are painted in: var()s resolved, a transparent
 * background showing what is behind it, and a filter's brightness (a pressed key) shifting all it covers,
 * as CSS does, scaling sRGB channels.
 */
const painted = (el: Element): { text: number[]; bg: number[] } => {
  const resolve = (at: Element, css: string): string =>
    css.replace(/var\((--[\w-]+)\)/g, (_, name: string) => getComputedStyle(at).getPropertyValue(name).trim());
  const chain: Element[] = [];
  for (let e: Element | null = el; e; e = e.parentElement ?? ((e.getRootNode() as ShadowRoot).host ?? null)) chain.push(e);
  const brightness = chain.map((e) => Number(/brightness\(([\d.]+)\)/.exec(resolve(e, getComputedStyle(e).filter))?.[1] ?? 1));
  const shift = (c: number[], from: number) => c.map((v) => Math.min(1, v * brightness.slice(from).reduce((a, b) => a * b, 1)));
  // Backgrounds from the element out, until an opaque one; then laid over each other.
  const layers: { rgb: number[]; alpha: number; at: number }[] = [];
  for (const [i, e] of chain.entries()) {
    const bg = parse(resolve(e, getComputedStyle(e).backgroundColor));
    if (bg.alpha > 0) layers.push({ ...bg, at: i });
    if (bg.alpha === 1) break;
  }
  if (!layers.length || layers.at(-1)!.alpha < 1) throw new Error(`nothing opaque behind ${el.className}`);
  const bg = layers.reduceRight((under: number[] | null, layer) => over(layer, under ?? layer.rgb), null)!;
  const text = over(parse(resolve(el, getComputedStyle(el).color)), bg);
  return { text: shift(text, 0), bg: shift(bg, layers[0]!.at) };
};

/** The QWERTY keyboard in `theme` with `mods`, a reading being converted and suggestions. */
const keyboard = (theme: Theme, mods: Partial<Mods> = {}): ShadowRoot => {
  const shadow = document.createElement('div').attachShadow({ mode: 'open' });
  document.body.append(shadow.host);
  const view = createView(document, shadow, boot.catalog.layouts['en/qwerty']!, theme, () => {});
  view.update({ ...NO_MODS, ...mods });
  view.setComposition({ segments: ['かんじ', 'を'], focus: 0, candidates: ['漢字', '感じ', '幹事'], selected: 0 });
  view.setSuggestions(['the', 'they', 'then']);
  longhandBackgrounds(shadow);
  return shadow;
};
const settings = (theme: Theme): ShadowRoot => {
  const shadow = document.createElement('div').attachShadow({ mode: 'open' });
  document.body.append(shadow.host);
  createSettingsView(document, shadow, theme, { theme: theme.id, haptics: true, suggestions: true, dictation: false, dictationContinuous: false, autoUpdate: true }, {
    themes: [], version: 'test', errors: [], suggestions: false, keyboardName: 'English', options: [], tab: 'general',
    keyboards: { all: [], ring: [], language: 'en' },
  }, { onTab: () => {}, onChange: () => {}, onOption: () => {}, onStock: () => {}, onClose: () => {}, onLanguage: () => {}, onKeyboards: () => {}, onUpdate: () => {} });
  longhandBackgrounds(shadow);
  return shadow;
};
const picker = (theme: Theme): ShadowRoot => {
  const shadow = document.createElement('div').attachShadow({ mode: 'open' });
  document.body.append(shadow.host);
  const sets = [emojiSet([{ id: 'smileys', name: 'Smileys', icon: 'smileys', items: ['😀'] }])];
  createEmojiView(document, shadow, theme, { sets, tones: toneTable(sets), steam: [] }, NO_EMOJI_STATE,
    { onItem: () => {}, onTone: () => {}, onSteam: () => {}, onFavorites: () => {}, onClearRecent: () => {} })
    .setBounds({ top: 0, left: 0, width: 854, height: 195 });
  longhandBackgrounds(shadow);
  return shadow;
};

const REST = [''];
const STATES = ['', 'hover'];
/** What is painted, where: a view, the element with the text, and the states it is seen in (classes added). */
const CASES: { name: string; view: (t: Theme) => ShadowRoot; at: string; states: string[] }[] = [
  { name: 'a key', view: keyboard, at: '.key[data-k="g"] .lbl', states: STATES },
  { name: 'a modifier', view: keyboard, at: '.key[data-k="Tab"] .lbl', states: STATES },
  { name: 'Fn', view: keyboard, at: '.key[data-k="fn"] .lbl', states: ['hover'] },
  { name: 'Shift locked', view: (t) => keyboard(t, { shift: 'locked' }), at: '.key[data-k="shift"] .lbl', states: STATES },
  { name: 'Fn locked', view: (t) => keyboard(t, { fn: 'locked' }), at: '.key[data-k="fn"] .lbl', states: STATES },
  { name: 'a candidate', view: keyboard, at: '.cand:not(.sel)', states: ['', 'hover'] },
  { name: 'the selected candidate', view: keyboard, at: '.cand.sel', states: ['', 'hover'] },
  { name: 'the focused segment', view: keyboard, at: '.seg.focus', states: REST },
  { name: 'a suggestion', view: keyboard, at: '.sugg:not(.best)', states: ['', 'hover'] },
  { name: 'the best suggestion', view: keyboard, at: '.sugg.best', states: ['hover'] },
  { name: 'the selected settings tab', view: settings, at: '.head .tab.on', states: REST },
  { name: 'an emoji', view: picker, at: '.strip .cell', states: ['', 'hover'] },
];

describe('theme contrast', () => {
  it('measures as WCAG does', () => {
    expect(ratio([1, 1, 1], [0, 0, 0])).toBeCloseTo(21, 6);
    expect(ratio(parse('#767676').rgb, [1, 1, 1])).toBeCloseTo(4.54, 2); // the lightest grey that passes AA on white
  });

  it.each(themes.map((t) => [t.id, t] as const))('%s: text reads at 4.5:1 in every state', (_, theme) => {
    const low: string[] = [];
    for (const { name, view, at, states } of CASES) {
      for (const state of states) {
        const shadow = view(theme);
        const el = shadow.querySelector(at);
        if (!el) throw new Error(`${name}: no ${at}`);
        // The state's classes go on the element that takes them: the key, not its label.
        const target = el.closest('.key') ?? el;
        if (state) target.classList.add(...state.split(' '));
        const { text, bg } = painted(el);
        const r = ratio(text, bg);
        if (r < 4.5) low.push(`${name}${state ? ` (${state})` : ''}: ${hex(text)} on ${hex(bg)}, ${r.toFixed(2)}:1`);
        shadow.host.remove();
      }
    }
    expect(low).toEqual([]);
  });
});
