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

/** How states shift by tone: a dark theme lightens a pressed key and a raised cell; a light one darkens. */
const TONE = {
  dark: { pressed: 'brightness(1.5)', raised: 'rgba(255, 255, 255, 0.1)' },
  light: { pressed: 'brightness(0.85)', raised: 'rgba(0, 0, 0, 0.06)' },
} as const;

/** The theme's CSS custom properties, as a style attribute value. */
export const themeVars = (theme: Theme): string => {
  const c = theme.colors;
  const vars: Record<string, string> = {
    '--surface': c.surface,
    '--key': c.key,
    '--text': c.keyText,
    '--mod': c.modifier,
    '--accent': c.accent,
    '--legend': c.legend ?? c.keyText,
    '--fn': c.fnLegend ?? c.accent,
    '--hover': c.hover ?? c.modifier,
    '--accent-text': c.accentText ?? c.surface,
    '--fn-text': c.fnText ?? c.surface,
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
  };
  return Object.entries(vars).map(([name, value]) => `${name}:${value};`).join('');
};
