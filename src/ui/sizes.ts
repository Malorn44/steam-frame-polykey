// Sizes as CSS custom properties, in two layers. The scale names sizes (Tailwind-style --text-3xs …
// --text-xl); roles say what each part of a key uses (--size-label, --size-hint, …) and point at a step.
// A preset ('normal', or 'large' for layouts read on phone-sized keys, like the 12-key) only re-points
// roles, so retuning the scale or moving one role changes every keyboard consistently.
//
// Values are today's look. Roles not on the scale yet (bar text, ゛゜小) keep their own value until
// they are settled.

/** The type scale. */
export const SCALE = {
  '--text-3xs': '10.2px', // Shift and Fn legends, JIS legends, the corner hint
  '--text-2xs': '11px', // flick-edge hints
  '--text-xs': '13px', // the digit beneath, modifier-key text
  '--text-sm': '17px', // main label (normal)
  '--text-md': '20px', // main label (large)
  '--text-lg': '22px', // text arrows
  '--text-xl': '26px', // 12-key kana
} as const;

export type SizePreset = 'normal' | 'large';

/** What each part of a key uses, by preset. */
const ROLES: Record<SizePreset, Record<string, string>> = {
  normal: {
    '--size-base': 'var(--text-sm)', // the keyboard's own text size (what popups and plain keys inherit)
    '--size-label': 'var(--text-sm)', // the main character or word on a key
    '--size-dual': 'var(--text-sm)', // the main character on a key with Latin and kana legends (JIS)
    '--size-legend': 'var(--text-3xs)', // Shift, Fn and the other alphabet's legends; the corner hint
    '--size-hint': 'var(--text-2xs)', // flick directions at a key's edges
    '--size-sub': 'var(--text-xs)', // small text beneath the label (the 2 under abc)
    '--size-mod': 'var(--text-xs)', // text on modifier and named keys (Ctrl, Tab, Enter)
    '--size-flick': 'var(--text-xl)', // a flick key's kana
    '--size-arrow': 'var(--text-lg)', // arrows drawn as text (JIS)
    '--size-modify': '21px', // ゛゜小
    '--size-icon': '18px', // key icons (large layouts draw them at 1.35em of this)
    '--size-bar-key': '14px', // toolbar keys
    '--size-suggestion': '15px', // word suggestions
    '--size-candidate': '16px', // conversion candidates and the reading, on top
    '--size-side-reading': '18px', // the reading, in the side panel
    '--size-side-candidate': '19px', // candidates, in the side panel
    '--size-placeholder': 'var(--text-xs)', // the message where candidates appear
  },
  large: {
    '--size-label': 'var(--text-md)',
  },
};

/** The scale and a preset's roles, as a style attribute value. */
export const sizeVars = (preset: SizePreset): string =>
  Object.entries({ ...SCALE, ...ROLES.normal, ...ROLES[preset] }).map(([name, value]) => `${name}:${value};`).join('');
