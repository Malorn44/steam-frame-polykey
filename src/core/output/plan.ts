// How output operations become HandleVirtualKeyDown calls. Pure.
//   run    ASCII one per call, other runs as one call (fjk, minimal mode: one keymap change per call)
//   chars  one grapheme per call (buffered mode moves its cursor one character per call)

/** Keys HandleVirtualKeyDown takes by name (VKClose hides Steam's keyboard). */
export type VkdKey = 'Backspace' | 'Enter' | 'Tab' | 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'VKClose';
export type OutputOp = { readonly text: string } | { readonly key: VkdKey };
export type SplitPolicy = 'run' | 'chars';
export type SplitSetting = 'auto' | SplitPolicy;
export type KeyboardMode = 'buffered' | 'minimal' | 'unknown';
/** Where the open keyboard types (host/steam/diag.ts reads it from the VR keyboard's overlay key). */
export type TargetKind = 'streamed' | 'local-app' | 'steam-ui' | 'unknown';

/** Gap between calls when Steam's buffer has to re-render in between (measured by fjk). */
export const BUFFERED_GAP_MS = 40;

/**
 * In minimal mode gamescope types a non-ASCII call through a temporary keymap, and what is sent next
 * must not change it before the target has read that call's keys, or they come out as number-row
 * digits. Each kind waits as long as it needs, from the end of that call:
 * - a key chord, KEYMAP_SETTLE_MS: text sent just before one (Copy while composing) came out as digits.
 *   The measurement below sent no chords, so this stays as it was.
 * - a named key (⌫, Enter), KEYMAP_SETTLE_KEY_MS. gamescope performs each as an action, as it does ⌫.
 * - text, KEYMAP_SETTLE_TEXT_MS.
 * Measured on a Frame (2026-11-15), with fixed test lines sent through Steam's keyboard manager into
 * Konsole in game mode: 120 trials per pattern at gaps of 0, 10, 20 and 30 ms. Wrong lines: retype
 * (ㅎ, ⌫하, ⌫한, ㄱ, ⌫그, ⌫글, the gap before each step, a ⌫ and its syllable back to back) 120, 30, 8,
 * 0, the wrong ones with digits (36, 3글, 한6); swap (가 나 다 라) and ascii (가 a 나 b) none at any
 * gap. Text after text needs no wait, and the ⌫ after a syllable does; the syllable after a ⌫ went
 * with none in every trial.
 */
export const KEYMAP_SETTLE_MS = 60;
export const KEYMAP_SETTLE_KEY_MS = 30;
export const KEYMAP_SETTLE_TEXT_MS = 0;

/** How long each kind of call waits after one that swapped the keymap (pace.ts). */
export type Settle = Readonly<Record<'text' | 'key' | 'chord', number>>;
export const KEYMAP_SETTLE: Settle = { text: KEYMAP_SETTLE_TEXT_MS, key: KEYMAP_SETTLE_KEY_MS, chord: KEYMAP_SETTLE_MS };

const PRINTABLE_ASCII = /^[\x20-\x7e]$/;
/** Whether a call needs a temporary keymap in minimal mode: it has something other than printable ASCII. */
export const swapsKeymap = (call: string): boolean => /[^\x20-\x7e]/.test(call);

let segmenter: Intl.Segmenter | null | undefined;

/** Split text into user-perceived characters, the way Steam's buffer counts them. */
export const graphemes = (text: string): string[] => {
  if (segmenter === undefined) {
    segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
      ? new Intl.Segmenter('ja', { granularity: 'grapheme' })
      : null;
  }
  return segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text);
};

/** Plan one string per call. Key names (e.g. "Backspace") pass through as they are. */
export const planCalls = (ops: readonly OutputOp[], policy: SplitPolicy): string[] => {
  const calls: string[] = [];
  for (const op of ops) {
    if ('key' in op) {
      calls.push(op.key);
      continue;
    }
    const parts = graphemes(op.text);
    if (policy === 'chars') {
      calls.push(...parts);
      continue;
    }
    let run = '';
    for (const part of parts) {
      if (PRINTABLE_ASCII.test(part)) {
        if (run) calls.push(run);
        run = '';
        calls.push(part);
      } else {
        run += part;
      }
    }
    if (run) calls.push(run);
  }
  return calls;
};

export interface Delivery {
  readonly policy: SplitPolicy;
  readonly gapMs: number;
  /** After a call that swaps the keymap, what is sent next (of this send or the next, or a chord) waits this long, by its kind; null: no wait. */
  readonly settle: Settle | null;
}

/** `auto`: fjk's behaviour when the mode is known, one character per call otherwise. */
export const chooseDelivery = (mode: KeyboardMode, setting: SplitSetting, gapOverrideMs?: number): Delivery => {
  const policy: SplitPolicy = setting !== 'auto' ? setting : mode === 'minimal' ? 'run' : 'chars';
  const defaultGap = mode === 'minimal' ? 0 : BUFFERED_GAP_MS;
  const gapMs = gapOverrideMs !== undefined && Number.isFinite(gapOverrideMs) ? Math.max(0, gapOverrideMs) : defaultGap;
  return { policy, gapMs, settle: mode === 'minimal' ? KEYMAP_SETTLE : null };
};
