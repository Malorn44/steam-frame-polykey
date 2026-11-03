// A theme as the CSS custom properties every view styles itself with. One place for the mapping and its
// defaults, so the keyboard, settings and emoji views (and anything drawn inside them: hold popups, the
// Keyboards page) always see the same full set.

import type { Theme } from '../core/catalog.js';

/** What a theme leaves out falls back to these (the colours fall back to other colours of the theme). */
export const THEME_DEFAULTS = { radius: 6, font: 'system-ui, sans-serif' } as const;

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
    '--radius': `${theme.radius ?? THEME_DEFAULTS.radius}px`,
    '--font': theme.font ?? THEME_DEFAULTS.font,
  };
  return Object.entries(vars).map(([name, value]) => `${name}:${value};`).join('');
};
