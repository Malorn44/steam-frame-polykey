// Key icons as SVG. Settings, emoji, mic, copy, cut, paste, close, backspace, the Frame mark and the
// Shift arrow are ported from TaiKeid's Steam Frame Full Keyboard (MIT, src/panel.cpp draw_icon);
// the globe and Caps are ours. 24-unit boxes centred on 0, stroked like the original (1.8, round).

const svg = (body: string, strokeWidth = 1.8): string =>
  `<svg viewBox="-12 -12 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="${strokeWidth}"`
  + ` stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const SHIFT_ARROW = 'M0 -7.1 L7 0.95 L3.64 0.95 L3.64 9 L-3.64 9 L-3.64 0.95 L-7 0.95 Z';

export const ICONS = {
  settings: svg('<path d="M11.00 0.00 L10.79 2.15 L7.85 3.25 L7.07 4.72 L7.78 7.78 L6.11 9.15 L3.25 7.85 L1.66 8.34 L0.00 11.00 L-2.15 10.79 L-3.25 7.85 L-4.72 7.07 L-7.78 7.78 L-9.15 6.11 L-7.85 3.25 L-8.34 1.66 L-11.00 0.00 L-10.79 -2.15 L-7.85 -3.25 L-7.07 -4.72 L-7.78 -7.78 L-6.11 -9.15 L-3.25 -7.85 L-1.66 -8.34 L-0.00 -11.00 L2.15 -10.79 L3.25 -7.85 L4.72 -7.07 L7.78 -7.78 L9.15 -6.11 L7.85 -3.25 L8.34 -1.66 Z"/><circle r="3.5"/>'),
  emoji: svg('<circle r="10"/><circle cx="-3.6" cy="-3" r="0.5"/><circle cx="3.6" cy="-3" r="0.5"/>'
    + '<path d="M4.9 3.5 A5.5 5.5 0 0 1 -4.9 3.5"/>'),
  dictate: svg('<rect x="-4" y="-11" width="8" height="14" rx="4"/><path d="M7.5 0 A7.5 7.5 0 0 1 -7.5 0 M0 7.5 V11 M-4 11 H4"/>'),
  copy: svg('<rect x="-3" y="-3" width="13" height="14" rx="2"/><path d="M4 -6 V-9 H-10 V5 H-6"/>'),
  cut: svg('<circle cx="-5.5" cy="7.5" r="3.5"/><circle cx="5.5" cy="7.5" r="3.5"/><path d="M-3.5 4.5 L6 -10 M3.5 4.5 L-6 -10"/>'),
  paste: svg('<path d="M-5 -8 H-9 V11 H9 V-8 H5"/><rect x="-5" y="-11" width="10" height="6" rx="2"/><path d="M-4 0 H4 M-4 5 H2"/>'),
  hide: svg('<path d="M-7 -7 L7 7 M7 -7 L-7 7"/>'),
  menu: svg('<path d="M-8 -6 H8 M-8 0 H8 M-8 6 H8"/>'),
  backspace: svg('<path d="M-12 -7 V7 M11 0 H-6 M0 -6 L-6 0 L0 6"/>', 2.3),
  globe: svg('<circle r="10"/><ellipse rx="4.5" ry="10"/><path d="M-10 0 H10 M-8.5 -5 H8.5 M-8.5 5 H8.5"/>'),
  shift: svg(`<path d="${SHIFT_ARROW}"/>`),
  shiftLocked: svg(`<path d="${SHIFT_ARROW}" fill="currentColor"/>`),
  caps: svg(`<path d="${SHIFT_ARROW}" transform="translate(0 -2)"/><path d="M-4 10.5 H4"/>`),
  capsOn: svg(`<path d="${SHIFT_ARROW}" transform="translate(0 -2)" fill="currentColor"/><path d="M-4 10.5 H4"/>`),
  // The Steam Frame mark (two bars and a quarter disc), traced by Full Keyboard from Valve's logo.
  frame: '<svg viewBox="128.5 128.5 194 194" width="1em" height="1em" fill="currentColor"><path d="M131.5 128.5 H319.5'
    + ' A3 3 0 0 1 322.5 131.5 V176 H176 V322.5 H131.5 A3 3 0 0 1 128.5 319.5 V131.5 A3 3 0 0 1 131.5 128.5 Z'
    + ' M322.5 322.5 H194.5 A128 128 0 0 1 322.5 194.5 Z"/></svg>',
} as const;

export type IconName = keyof typeof ICONS;
