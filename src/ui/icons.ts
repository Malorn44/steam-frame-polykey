// Key icons as SVG. Settings, emoji, mic, copy, cut, paste, close (✕), backspace, the Frame mark and
// the Shift arrow are ported from TaiKeid's Steam Frame Full Keyboard (MIT, src/panel.cpp draw_icon);
// the globe, Caps, hide (after Steam's hide key) and back are ours. 24-unit boxes centred on 0, stroked
// like the original (1.8, round).

/** One stroke for every icon, 1.8 unless a theme sets --icon-stroke (look decision d). */
const svg = (body: string, strokeWidth = 1.8): string =>
  `<svg viewBox="-12 -12 24 24" width="1em" height="1em" fill="none" stroke="currentColor" style="stroke-width: var(--icon-stroke, ${strokeWidth})"`
  + ` stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const SHIFT_ARROW = 'M0 -7.1 L7 0.95 L3.64 0.95 L3.64 9 L-3.64 9 L-3.64 0.95 L-7 0.95 Z';

export const ICONS = {
  settings: svg(
    '<path d="M11.00 0.00 L10.79 2.15 L7.85 3.25 L7.07 4.72 L7.78 7.78 L6.11 9.15 L3.25 7.85 L1.66 8.34 L0.00 11.00 L-2.15 10.79 L-3.25 7.85 L-4.72 7.07 L-7.78 7.78 L-9.15 6.11 L-7.85 3.25 L-8.34 1.66 L-11.00 0.00 L-10.79 -2.15 L-7.85 -3.25 L-7.07 -4.72 L-7.78 -7.78 L-6.11 -9.15 L-3.25 -7.85 L-1.66 -8.34 L-0.00 -11.00 L2.15 -10.79 L3.25 -7.85 L4.72 -7.07 L7.78 -7.78 L9.15 -6.11 L7.85 -3.25 L8.34 -1.66 Z"/><circle r="3.5"/>',
  ),
  emoji: svg(
    '<circle r="10"/><circle cx="-3.6" cy="-3" r="0.5"/><circle cx="3.6" cy="-3" r="0.5"/>'
      + '<path d="M4.9 3.5 A5.5 5.5 0 0 1 -4.9 3.5"/>',
  ),
  dictate: svg(
    '<rect x="-4" y="-11" width="8" height="14" rx="4"/><path d="M7.5 0 A7.5 7.5 0 0 1 -7.5 0 M0 7.5 V11 M-4 11 H4"/>',
  ),
  copy: svg('<rect x="-3" y="-3" width="13" height="14" rx="2"/><path d="M4 -6 V-9 H-10 V5 H-6"/>'),
  cut: svg(
    '<circle cx="-5.5" cy="7.5" r="3.5"/><circle cx="5.5" cy="7.5" r="3.5"/><path d="M-3.5 4.5 L6 -10 M3.5 4.5 L-6 -10"/>',
  ),
  paste: svg(
    '<path d="M-5 -8 H-9 V11 H9 V-8 H5"/><rect x="-5" y="-11" width="10" height="6" rx="2"/><path d="M-4 0 H4 M-4 5 H2"/>',
  ),
  // Hide the keyboard: a keyboard with a filled arrow under it, after Steam's own hide key (our own
  // drawing, filled like Steam's).
  hide:
    '<svg viewBox="-12 -12 24 24" width="1em" height="1em" fill="currentColor"><path fill-rule="evenodd" d="'
    + 'M-10.5 -8.6h21a1 1 0 0 1 1 1v10.6a1 1 0 0 1 -1 1h-21a1 1 0 0 1 -1 -1v-10.6a1 1 0 0 1 1 -1z' // the keyboard
    + 'M-8.75 -6.6h2v2h-2zM-5.65 -6.6h2v2h-2zM-2.55 -6.6h2v2h-2zM0.55 -6.6h2v2h-2zM3.65 -6.6h2v2h-2zM6.75 -6.6h2v2h-2z'
    + 'M-8.75 -3.6h2v2h-2zM-5.65 -3.6h2v2h-2zM-2.55 -3.6h2v2h-2zM0.55 -3.6h2v2h-2zM3.65 -3.6h2v2h-2zM6.75 -3.6h2v2h-2z'
    + 'M-8.75 -0.6h2v2h-2zM6.75 -0.6h2v2h-2zM-5.65 -0.6h11.3v2h-11.3z' // its keys, cut out
    + 'M-3.6 6.4H3.6L0 10z"/></svg>', // the arrow
  /** ✕: remove or delete something (a keyboard from your list, a model). */
  close: svg('<path d="M-7 -7 L7 7 M7 -7 L-7 7"/>'),
  /** Back out of settings to the keys. */
  back: svg('<path d="M4 -8 L-4 0 L4 8"/>'),
  menu: svg('<path d="M-8 -6 H8 M-8 0 H8 M-8 6 H8"/>'),
  // Emoji picker tabs and the Recent bin, ported from Full Keyboard (MIT, src/panel.cpp draw_icon).
  recent: svg('<circle r="10"/><path d="M0 0 V-6 M0 0 L4.5 2.5"/>'),
  favorites: svg(
    '<path d="M0 -9.7 L2.59 -2.76 L9.99 -2.44 L4.18 2.16 L6.17 9.29 L0 5.2 L-6.17 9.29 L-4.18 2.16 L-9.99 -2.44 L-2.59 -2.76 Z"/>',
  ),
  smileys: svg(
    '<circle r="10"/><circle cx="-3.6" cy="-3" r="0.5"/><circle cx="3.6" cy="-3" r="0.5"/><path d="M-5.5 2 H5.5 A5.5 5.5 0 0 1 -5.5 2 Z"/>',
  ),
  people: svg('<circle cy="-5" r="4"/><path d="M-8.5 11 A8.5 8.5 0 0 1 8.5 11"/>'),
  animals: svg(
    '<circle cy="5" r="4.5"/><circle cx="-7.5" cy="-1.5" r="2"/><circle cx="-3" cy="-7" r="2"/><circle cx="3" cy="-7" r="2"/><circle cx="7.5" cy="-1.5" r="2"/>',
  ),
  food: svg('<path d="M-9 -1 A9 9 0 0 1 9 -1 Z M-9.5 3 H9.5"/><rect x="-9" y="6" width="18" height="4" rx="2"/>'),
  travel: svg(
    '<rect x="-10.5" y="-1" width="21" height="7" rx="2"/><path d="M-6.5 -1 L-4 -6.5 H4 L6.5 -1"/><circle cx="-5.5" cy="8" r="2.2"/><circle cx="5.5" cy="8" r="2.2"/>',
  ),
  activities: svg(
    '<circle r="10"/><path d="M0 -10 V10 M-10 0 H10 M-7.03 -7.17 A10 10 0 0 1 -7.03 7.17 M7.03 7.17 A10 10 0 0 1 7.03 -7.17"/>',
  ),
  objects: svg('<path d="M-4.83 2.74 A7.5 7.5 0 1 1 4.83 2.74 L3 6 H-3 Z M-2.5 9.5 H2.5"/>'),
  symbols: svg('<path d="M0 9 C-13 0 -7 -11 0 -4.5 C7 -11 13 0 0 9 Z"/>'),
  flags: svg('<path d="M-7 -10 V11 M-7 -9.5 H8.5 L5 -5 L8.5 -0.5 H-7"/>'),
  clear: svg('<path d="M-8.5 -6 H8.5 M-3 -6 V-9 H3 V-6 M-6 -6 L-5 10 H5 L6 -6 M-2 -2 V6 M2 -2 V6"/>'),
  // Steam item tabs: ours, drawn to match the set above (outlines on the same 24-unit box).
  emoticons: svg(
    '<path d="M-8 -9 H8 A2.5 2.5 0 0 1 10.5 -6.5 V3.5 A2.5 2.5 0 0 1 8 6 H-1 L-6 10.5 V6 H-8 A2.5 2.5 0 0 1 -10.5 3.5 V-6.5 A2.5 2.5 0 0 1 -8 -9 Z"/>'
      + '<circle cx="-3.6" cy="-3.5" r="0.5"/><circle cx="3.6" cy="-3.5" r="0.5"/><path d="M-4 0.5 A5 5 0 0 0 4 0.5"/>',
  ),
  stickers: svg(
    '<path d="M-7.5 -10 H7.5 A2.5 2.5 0 0 1 10 -7.5 V2 L2 10 H-7.5 A2.5 2.5 0 0 1 -10 7.5 V-7.5 A2.5 2.5 0 0 1 -7.5 -10 Z M10 2 H4.5 A2.5 2.5 0 0 0 2 4.5 V10"/>',
  ),
  effects: svg(
    '<path d="M-2.5 -9.5 Q-0.74 -3.26 5.5 -1.5 Q-0.74 0.26 -2.5 6.5 Q-4.26 0.26 -10.5 -1.5 Q-4.26 -3.26 -2.5 -9.5 Z"/><path d="M6.5 2.5 Q7.38 5.62 10.5 6.5 Q7.38 7.38 6.5 10.5 Q5.62 7.38 2.5 6.5 Q5.62 5.62 6.5 2.5 Z"/>'
      + '<circle cx="7" cy="-7.5" r="0.6"/><circle cx="-8.5" cy="8.5" r="0.6"/><circle cx="1" cy="10" r="0.6"/>',
  ),
  backspace: svg('<path d="M-12 -7 V7 M11 0 H-6 M0 -6 L-6 0 L0 6"/>'),
  // 12-key side keys. Undo and backspace from frame-jp-keyboard (MIT, src/icons.js; its 24 grid starts at
  // 0, hence the shift); return and the arrows are ours, drawn to match.
  undo: svg(
    '<g transform="translate(-12 -12)"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></g>',
  ),
  backspaceTag: svg(
    '<g transform="translate(-12 -12)"><path d="M21 5H9l-7 7 7 7h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1z"/>'
      + '<path d="M12 9l6 6"/><path d="M18 9l-6 6"/></g>',
  ),
  enter: svg('<path d="M8 -7 V0 A3 3 0 0 1 5 3 H-8 M-4 -1 L-8 3 L-4 7"/>'),
  left: svg('<path d="M8 0 H-8 M-2 -6 L-8 0 L-2 6"/>'),
  /** The space mark (⎵): a bracket open upwards. */
  space: svg('<path d="M-9 -1 V4 H9 V-1"/>'),
  right: svg('<path d="M-8 0 H8 M2 -6 L8 0 L2 6"/>'),
  up: svg('<path d="M0 8 V-8 M-6 -2 L0 -8 L6 -2"/>'),
  down: svg('<path d="M0 -8 V8 M-6 2 L0 8 L6 2"/>'),
  /** A dropdown's arrow (settings' theme picker); ours. */
  chevron: svg('<path d="M-6 -3 L0 3 L6 -3"/>'),
  globe: svg('<circle r="10"/><ellipse rx="4.5" ry="10"/><path d="M-10 0 H10 M-8.5 -5 H8.5 M-8.5 5 H8.5"/>'),
  shift: svg(`<path d="${SHIFT_ARROW}"/>`),
  shiftLocked: svg(`<path d="${SHIFT_ARROW}" fill="currentColor"/>`),
  caps: svg(`<path d="${SHIFT_ARROW}" transform="translate(0 -2)"/><path d="M-4 10.5 H4"/>`),
  capsOn: svg(`<path d="${SHIFT_ARROW}" transform="translate(0 -2)" fill="currentColor"/><path d="M-4 10.5 H4"/>`),
  // The Steam Frame mark (two bars and a quarter disc), traced by Full Keyboard from Valve's logo.
  frame:
    '<svg viewBox="128.5 128.5 194 194" width="1em" height="1em" fill="currentColor"><path d="M131.5 128.5 H319.5'
    + ' A3 3 0 0 1 322.5 131.5 V176 H176 V322.5 H131.5 A3 3 0 0 1 128.5 319.5 V131.5 A3 3 0 0 1 131.5 128.5 Z'
    + ' M322.5 322.5 H194.5 A128 128 0 0 1 322.5 194.5 Z"/></svg>',
  // 文A, back to polykey from Steam's keyboard. Phosphor Icons "translate" (regular), MIT License,
  // Copyright (c) 2023 Phosphor Icons, https://github.com/phosphor-icons/core.
  translate:
    '<svg viewBox="0 0 256 256" width="1em" height="1em" fill="currentColor"><path d="M247.15,212.42l-56-112a8,8,0,0,0-14.31,0l-21.71,43.43A88,88,0,0,1,108,126.93,103.65,103.65,0,0,0,135.69,64H160a8,8,0,0,0,0-16H104V32a8,8,0,0,0-16,0V48H32a8,8,0,0,0,0,16h87.63A87.76,87.76,0,0,1,96,116.35a87.74,87.74,0,0,1-19-31,8,8,0,1,0-15.08,5.34A103.63,103.63,0,0,0,84,127a87.55,87.55,0,0,1-52,17,8,8,0,0,0,0,16,103.46,103.46,0,0,0,64-22.08,104.18,104.18,0,0,0,51.44,21.31l-26.6,53.19a8,8,0,0,0,14.31,7.16L148.94,192h70.11l13.79,27.58A8,8,0,0,0,240,224a8,8,0,0,0,7.15-11.58ZM156.94,176,184,121.89,211.05,176Z"/></svg>',
} as const;

export type IconName = keyof typeof ICONS;

/** ⓘ, a model's or the engine's details (Settings → Dictation); not a key icon packs can name. */
export const INFO_ICON = svg('<circle r="10"/><path d="M0 -1 V6"/><circle cy="-5.2" r="0.4"/>');

/**
 * A model's speed as four rising bars, like a signal meter: `level` of them filled (currentColor), the
 * rest faint. Filled shapes, so no stroke.
 */
export const signalBars = (level: number): string =>
  '<svg viewBox="0 0 16 14" width="1.15em" height="1em" fill="currentColor">'
  + [0, 1, 2, 3]
    .map(
      (i) =>
        `<rect x="${i * 4 + 0.5}" y="${11 - i * 3}" width="3" height="${3 + i * 3}" rx="0.8"`
        + `${i < level ? '' : ' opacity="0.25"'}/>`,
    )
    .join('')
  + '</svg>';

/**
 * Desktop icons, and a layout read on phone-sized keys (iconSet "phone", e.g. the 12-key) draws a few
 * more (font glyphs render tiny in the headset, fjk), by what the key does: an action, a named key, a
 * modifier, or " " for a space key. Shift and Caps switch to their locked forms in the view.
 */
export const ICON_DEFAULTS: Partial<Record<string, { desktop?: IconName; phone?: IconName }>> = {
  settings: { desktop: 'settings' },
  emoji: { desktop: 'emoji' },
  dictate: { desktop: 'dictate' },
  copy: { desktop: 'copy' },
  cut: { desktop: 'cut' },
  paste: { desktop: 'paste' },
  menu: { desktop: 'menu' },
  hide: { desktop: 'hide' },
  'next-keyboard': { desktop: 'globe' },
  ' ': { desktop: 'space' },
  Backspace: { desktop: 'backspace', phone: 'backspaceTag' },
  super: { desktop: 'frame' },
  shift: { desktop: 'shift' },
  caps: { desktop: 'caps' },
  undo: { phone: 'undo' },
  Enter: { phone: 'enter' },
  ArrowLeft: { phone: 'left' },
  ArrowRight: { phone: 'right' },
  ArrowUp: { phone: 'up' },
  ArrowDown: { phone: 'down' },
};

export type IconSet = 'desktop' | 'phone';

/** A key's default icon in a set: a phone icon, else the desktop one. */
export const defaultIcon = (id: string, set: IconSet): IconName | undefined =>
  (set === 'phone' ? ICON_DEFAULTS[id]?.phone : undefined) ?? ICON_DEFAULTS[id]?.desktop;
