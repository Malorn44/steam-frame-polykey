// The mic key's dictation visuals, after Full Keyboard's design (docs/dictation.md, "Mic key"; our own
// code): while listening, five bars replace the icon and the speech level passes through them from right
// to left, each easing to its height, the left ones fainter; while a phrase is recognized, a short bright
// segment circles just inside the border; while a model downloads, a slim track along the foot fills.
// Bars are sized in em, so they follow the key's icon size (the toolbar's or a large layout's). Only
// transforms change, and only when the sidecar sends a level, so silence repaints nothing.

import type { MicState } from '../core/dictation.js';

const BARS = 5;
/** The sidecar's levels run 0..LEVEL_MAX (session.py). */
const LEVEL_MAX = 8;
const FLAT = 0.14;

// A band just inside the border, masked out of a rotating conic gradient: only its short bright arc shows.
export const MIC_CSS = `
.key .mic-bars { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; gap: 0.16em;
  font-size: var(--size-icon); pointer-events: none; }
.bar .key .mic-bars { font-size: var(--size-bar-icon); }
.key.listening .mic-bars { display: flex; }
.key.listening > .lbl { visibility: hidden; }
.mic-bars i { width: 0.13em; height: 1em; border-radius: 0.07em; background: currentColor; transform: scaleY(${FLAT});
  transition: transform 0.12s ease-out; }
.mic-bars i:nth-child(1) { opacity: 0.35; }
.mic-bars i:nth-child(2) { opacity: 0.5; }
.mic-bars i:nth-child(3) { opacity: 0.65; }
.mic-bars i:nth-child(4) { opacity: 0.82; }
.key .mic-ring { position: absolute; inset: 1px; padding: 2px; border-radius: inherit; overflow: hidden; display: none;
  pointer-events: none; -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor; mask-composite: exclude; }
.key.recognizing .mic-ring { display: block; }
.mic-ring::before { content: ''; position: absolute; left: 50%; top: 50%; width: 300%; aspect-ratio: 1; translate: -50% -50%;
  background: conic-gradient(var(--ring) 0 46deg, transparent 46deg); animation: mic-spin 1.1s linear infinite; }
@keyframes mic-spin { to { rotate: 1turn; } }
@media (prefers-reduced-motion: reduce) {
  .mic-ring::before { animation: none; background: var(--ring); opacity: var(--opacity-muted); }
  .mic-bars i { transition: none; }
}
.key .mic-track { position: absolute; left: 16%; right: 16%; bottom: 2px; height: 2px; border-radius: 1px; overflow: hidden;
  display: none; pointer-events: none; background: color-mix(in srgb, currentColor 25%, transparent); }
.key.fetching .mic-track { display: block; }
.mic-track i { display: block; height: 100%; background: var(--accent); transform-origin: left; transform: scaleX(0);
  transition: transform 0.3s; }
.key.fetching > .lbl { opacity: var(--opacity-dim); }
`;

export interface MicKey {
  setState(state: MicState): void;
  /** The last BARS levels, oldest first (the sidecar's `bars`). */
  setLevels(levels: readonly number[]): void;
  /** A download's progress, 0..1, with the key disabled; null: none. */
  setProgress(fraction: number | null): void;
  /** A phrase is being recognized while listening goes on (continuous dictation): the arc around the bars. */
  setBusy(busy: boolean): void;
}

/** The parts the visuals need, added to a mic key once; its label stays as it is. */
export const micKey = (doc: Document, el: HTMLElement): MicKey => {
  const part = (className: string): HTMLElement => Object.assign(doc.createElement('span'), { className });
  const bars = part('mic-bars');
  const cells = Array.from({ length: BARS }, () => bars.appendChild(doc.createElement('i')));
  const track = part('mic-track');
  const fill = track.appendChild(doc.createElement('i'));
  el.append(bars, part('mic-ring'), track);
  const levels = (values: readonly number[]): void => {
    cells.forEach((cell, i) => {
      const level = Math.min(LEVEL_MAX, Math.max(0, values[values.length - BARS + i] ?? 0));
      cell.style.transform = `scaleY(${(FLAT + ((1 - FLAT) * level) / LEVEL_MAX).toFixed(3)})`;
    });
  };
  let state: MicState = 'idle';
  let busy = false;
  const show = (): void => {
    el.classList.toggle('locked', state === 'listening');
    el.classList.toggle('listening', state === 'listening');
    el.classList.toggle('recognizing', state === 'transcribing' || (state === 'listening' && busy));
    el.classList.toggle('err', state === 'error');
  };
  return {
    setState: (next) => {
      state = next;
      if (next !== 'listening') {
        busy = false;
        levels([]); // flat for the next time
      }
      show();
    },
    setBusy: (next) => {
      busy = next;
      show();
    },
    setLevels: levels,
    setProgress: (fraction) => {
      el.classList.toggle('fetching', fraction !== null);
      fill.style.transform = `scaleX(${Math.min(1, Math.max(0, fraction ?? 0)).toFixed(3)})`;
    },
  };
};
