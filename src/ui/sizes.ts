// Sizes as CSS custom properties, in two layers. The scale names sizes (Tailwind-style --text-3xs …
// --text-xl); roles say what each part of a key uses (--size-label, --size-hint, …) and point at a step.
// A preset ('normal', or 'large' for layouts read on phone-sized keys, like the 12-key) only re-points
// roles, so retuning the scale or moving one role changes every keyboard consistently.
//
// Every key role is a step on the scale. The candidate bar's text (suggestions, candidates, the side
// panel) still has its own values.

/** The type scale. */
export const SCALE = {
  '--text-3xs': '10.2px', // Shift and Fn legends, JIS legends, the corner hint
  '--text-2xs': '11px', // flick-edge hints
  '--text-xs': '13px', // the digit beneath, modifier-key text
  '--text-sm': '17px', // main label (normal)
  '--text-md': '20px', // main label (large)
  '--text-lg': '22px', // (unused now)
  '--text-xl': '26px', // 12-key kana
} as const;

export type SizePreset = 'normal' | 'large';

/** What each part of a key uses, by preset. */
const ROLES: Record<SizePreset, Record<string, string>> = {
  normal: {
    '--size-base': 'var(--text-sm)', // the keyboard's own text size (what popups and plain keys inherit)
    '--size-label': 'var(--text-sm)', // the main character or word on a key
    '--size-dual': 'var(--text-sm)', // the main character on a key with Latin and kana legends (JIS)
    '--size-legend': 'var(--text-2xs)', // Shift, Fn and the other alphabet's legends; the corner hint
    '--size-hint': 'var(--text-2xs)', // flick directions at a key's edges
    '--size-sub': 'var(--text-xs)', // small text beneath the label (the 2 under abc)
    '--size-mod': 'var(--text-xs)', // text on modifier and named keys (Ctrl, Tab, Enter)
    '--size-flick': 'var(--text-xl)', // a flick key's kana
    '--size-modify': 'var(--text-md)', // ゛゜小 as plain text
    // ゛ and ゜ on their own (boxed) fill only a corner of their cell, so they are set larger than a label.
    '--size-mark': 'var(--text-xl)', // on the ゛゜ key, and as a JIS key's kana legend
    '--size-icon': 'var(--text-sm)', // key icons
    '--size-bar-icon': 'var(--text-sm)', // toolbar icons
    '--size-bar-key': 'var(--text-xs)', // toolbar text
    '--size-suggestion': '15px', // word suggestions
    '--size-candidate': '16px', // conversion candidates and the reading, on top
    '--size-side-reading': '18px', // the reading, in the side panel
    '--size-side-candidate': '19px', // candidates, in the side panel
    '--size-placeholder': 'var(--text-xs)', // the message where candidates appear
  },
  large: {
    '--size-label': 'var(--text-md)',
    '--size-icon': 'var(--text-xl)', // read through the headset (fjk)
  },
};

/** The scale and a preset's roles, as a style attribute value. */
export const sizeVars = (preset: SizePreset): string =>
  Object.entries({ ...SCALE, ...ROLES.normal, ...ROLES[preset] }).map(([name, value]) => `${name}:${value};`).join('');
