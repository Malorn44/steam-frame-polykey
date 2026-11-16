// Composing in the text field, the way Steam's own keyboard types Korean (ibus-hangul with no preedit):
// what is being composed is typed into the field, and each change deletes the part that differs and
// types it again (하 → 한 is ⌫ 한; 한 + ㄱ just types ㄱ). Pure. The field can't be read, so the only
// text ever deleted is the tail: what polykey itself typed of the composition, as it will stand once the
// sends queued before are made. The bar controller (src/bar.ts) keeps it, and forgets it, without a
// Backspace, whenever the field may have changed. Typed text: never logged.

import type { Effect } from '../keyboard.js';
import { graphemes, type TargetKind } from './plan.js';

/** What changes in the field: Backspaces over the end of the tail, then text. */
export interface InlinePlan {
  readonly erase: number;
  readonly text: string;
}

/**
 * Turn the field's tail into `commit` (sent for good) followed by `preedit` (still composed, the new
 * tail): keep what they have in common at the start, delete the rest of the tail, type the rest.
 */
export const planInline = (tail: string, commit: string, preedit: string): InlinePlan => {
  const was = graphemes(tail);
  const now = graphemes(commit + preedit);
  let same = 0;
  while (same < was.length && same < now.length && was[same] === now[same]) same += 1;
  return { erase: was.length - same, text: now.slice(same).join('') };
};

const planEffects = ({ erase, text }: InlinePlan): Effect[] => [
  ...Array.from({ length: erase }, (): Effect => ({ kind: 'key', key: 'Backspace' })),
  ...(text ? [{ kind: 'text', text } as const] : []),
];

/**
 * One step of a composition typed into the field: the composer's effects (what it sends for good) and
 * what it composes now (null: the field keeps what it shows, while the bar shows a conversion), against
 * the tail typed so far. Gives what to send and the new tail. Text the composer sends first is
 * compared with the tail; anything else it sends (a key) goes after the tail is settled, and what is
 * composed is typed after that.
 */
export const retype = (tail: string, effects: readonly Effect[], composed: string | null): { effects: Effect[]; tail: string } => {
  const split = effects.findIndex((effect) => effect.kind !== 'text');
  const lead = (split < 0 ? effects : effects.slice(0, split)).map((effect) => (effect.kind === 'text' ? effect.text : '')).join('');
  if (split < 0) {
    const preedit = composed ?? (lead ? '' : tail);
    return { effects: planEffects(planInline(tail, lead, preedit)), tail: preedit };
  }
  const now = composed ?? '';
  return {
    effects: [...planEffects(planInline(tail, lead, '')), ...effects.slice(split), ...planEffects(planInline('', '', now))],
    tail: now,
  };
};

/**
 * Whether a composer that can compose in the field retypes there for a target: in Steam's own UI and in
 * apps on gamescope (games), as Steam's keyboard does. Desktop Mode is typed into by pasting
 * (sidecar/polykey/desktop.py), a paste for each jamo, and streamed targets are unmeasured, so both keep
 * the bar. `desktop`: whether the desktop has gamescope's focus, as the sidecar last said for this target
 * (undefined: not known yet, so the bar until it is).
 */
export const retypesInField = (target: TargetKind, desktop: boolean | undefined): boolean =>
  target === 'steam-ui' || (target === 'local-app' && desktop === false);
