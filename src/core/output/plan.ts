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

/** How long each kind of call waits after one that swapped the keymap (pace.ts). */
export type Settle = Readonly<Record<'text' | 'key' | 'chord', number>>;

/**
 * In minimal mode gamescope types a non-ASCII call through a temporary keymap. What is sent next must
 * not change it before the target has read that call's keys, or they come out as number-row digits, so
 * each kind waits as long as it needs, from the end of that call:
 * - text: none; text straight after text comes out right.
 * - a named key (⌫, Enter, the arrows), which gamescope performs as an action: a ⌫ straight after a
 *   syllable (Hangul retyped in the field) turns that syllable into digits.
 * - a key chord: text sent just before one (Copy while composing) comes out as digits.
 */
export const KEYMAP_SETTLE: Settle = { text: 0, key: 30, chord: 60 };

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

/** One HandleVirtualKeyDown call: its string, and whether it is text or a key by name. */
export interface PlannedCall {
  readonly call: string;
  readonly kind: 'text' | 'key';
}

/** Plan the calls, in order. Key names (e.g. "Backspace") pass through as they are. */
export const planCalls = (ops: readonly OutputOp[], policy: SplitPolicy): PlannedCall[] => {
  const calls: PlannedCall[] = [];
  const text = (call: string): void => { calls.push({ call, kind: 'text' }); };
  for (const op of ops) {
    if ('key' in op) {
      calls.push({ call: op.key, kind: 'key' });
      continue;
    }
    const parts = graphemes(op.text);
    if (policy === 'chars') {
      for (const part of parts) text(part);
      continue;
    }
    let run = '';
    for (const part of parts) {
      if (PRINTABLE_ASCII.test(part)) {
        if (run) text(run);
        run = '';
        text(part);
      } else {
        run += part;
      }
    }
    if (run) text(run);
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
