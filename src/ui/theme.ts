// A theme as the CSS custom properties every view styles itself with. One place for the mapping and its
// defaults, so the keyboard, settings and emoji views (and anything drawn inside them: hold popups, the
// Keyboards page) always see the same full set.

import type { Theme } from '../core/catalog.js';

/** What a theme leaves out falls back to these (the colours fall back to other colours of the theme). */
export const THEME_DEFAULTS = {
  radius: 6, radiusSmall: 3, radiusPill: 13,
  font: 'system-ui, sans-serif',
  fontCjk: '"Noto Sans CJK JP", "Noto Sans JP"',
  shadow: '0 2px 10px rgba(0, 0, 0, 0.6)',
  shadowLarge: '0 4px 14px rgba(0,0,0,0.6)',
} as const;

/**
 * The fonts kaomoji draw in, whatever the theme's: faces mix kana, symbols and marks from many scripts,
 * and the Frame's system-ui (Cantarell) draws some of them blank and sends others to odd fallbacks.
 */
export const KAOMOJI_FONT = '"Noto Sans CJK JP", "Noto Sans", "Noto Sans Symbols 2", "Noto Sans Symbols", sans-serif';

/** How states shift by tone: a dark theme lightens a pressed key and a raised cell; a light one darkens. */
const TONE = {
  dark: { pressed: 'brightness(1.5)', raised: 'rgba(255, 255, 255, 0.1)' },
  light: { pressed: 'brightness(0.85)', raised: 'rgba(0, 0, 0, 0.06)' },
} as const;

/** WCAG's AA contrast for text: what text keeps against the background a state paints behind it. */
const READABLE = 4.5;

type Rgb = readonly number[];

/** #rrggbb as sRGB channels, 0..1; #rrggbbaa laid over `under`. */
const rgb = (hex: string, under?: Rgb): Rgb => {
  const channel = (i: number): number => parseInt(hex.slice(i, i + 2), 16) / 255;
  const alpha = under && hex.length > 7 ? channel(7) : 1;
  return [1, 3, 5].map((i, n) => channel(i) * alpha + (under?.[n] ?? 0) * (1 - alpha));
};

/** WCAG 2's contrast ratio, 1 to 21. */
const contrast = (a: Rgb, b: Rgb): number => {
  const luminance = (c: Rgb): number => {
    const [r = 0, g = 0, b = 0] = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/**
 * Text for `backgrounds` (on the surface): the first of `texts` that reads on all of them, else white or
 * black, whichever reads better.
 */
const textOn = (backgrounds: string[], texts: string[], surface: string): string => {
  const reads = (text: string): number => Math.min(...backgrounds.map((bg) => {
    const under = rgb(bg, rgb(surface));
    return contrast(rgb(text, under), under);
  }));
  return texts.find((t) => reads(t) >= READABLE) ?? (reads('#ffffff') >= reads('#000000') ? '#ffffff' : '#000000');
};

/** The theme's CSS custom properties, as a style attribute value. */
export const themeVars = (theme: Theme): string => {
  const c = theme.colors;
  const fn = c.fnLegend ?? c.accent;
  // The text on each background a state paints: the theme's own where it reads, else another of its
  // text colours, else white or black.
  const texts = [c.keyText, c.surface, ...(c.accentText ? [c.accentText] : [])];
  const on = (backgrounds: string[], own: string): string => textOn(backgrounds, [own, ...texts], c.surface);
  const vars: Record<string, string> = {
    '--surface': c.surface,
    '--key': c.key,
    '--text': c.keyText,
    '--mod': c.modifier,
    '--accent': c.accent,
    '--legend': c.legend ?? c.keyText,
    '--fn': fn,
    '--hover': c.hover ?? c.modifier,
    '--accent-text': on([c.accent], c.accentText ?? c.surface),
    '--fn-text': on([fn], c.fnText ?? c.surface),
    '--error': c.error ?? c.fnLegend ?? c.accent,
    '--divider': c.divider ?? c.modifier,
    '--ring': c.ring ?? c.accent,
    '--indicator': c.indicator ?? c.accent,
    '--pressed': TONE[theme.tone ?? 'dark'].pressed,
    '--raised': TONE[theme.tone ?? 'dark'].raised,
    '--shadow': theme.shadow ?? THEME_DEFAULTS.shadow,
    '--shadow-lg': theme.shadowLarge ?? THEME_DEFAULTS.shadowLarge,
    '--opacity-dim': '0.35',
    '--opacity-muted': '0.7',
    '--radius': `${theme.radius ?? THEME_DEFAULTS.radius}px`,
    '--radius-sm': `${theme.radiusSmall ?? THEME_DEFAULTS.radiusSmall}px`,
    '--radius-pill': `${theme.radiusPill ?? THEME_DEFAULTS.radiusPill}px`,
    '--font': theme.font ?? THEME_DEFAULTS.font,
    '--font-cjk': theme.fontCjk ?? THEME_DEFAULTS.fontCjk,
    '--font-kaomoji': KAOMOJI_FONT,
  };
  return Object.entries(vars).map(([name, value]) => `${name}:${value};`).join('');
};
