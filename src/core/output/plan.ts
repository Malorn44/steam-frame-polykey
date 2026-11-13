// How output operations become HandleVirtualKeyDown calls. Pure.
//   run    ASCII one per call, other runs as one call (fjk, minimal mode: one keymap change per call)
//   chars  one grapheme per call (buffered mode moves its cursor one character per call)

/** Keys HandleVirtualKeyDown takes by name (VKClose hides Steam's keyboard). */
export type VkdKey = 'Backspace' | 'Enter' | 'Tab' | 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'VKClose';
export type OutputOp = { readonly text: string } | { readonly key: VkdKey };
export type SplitPolicy = 'run' | 'chars';
export type SplitSetting = 'auto' | SplitPolicy;
export type KeyboardMode = 'buffered' | 'minimal' | 'unknown';

/** Gap between calls when Steam's buffer has to re-render in between (measured by fjk). */
export const BUFFERED_GAP_MS = 40;

/**
 * In minimal mode gamescope types a non-ASCII call through a temporary keymap. The next call waits this
 * long, so its own keys (or its own keymap) do not land before the target has read these: without it,
 * a kaomoji's calls, or two tapped in quick succession, come out as stray or missing characters.
 */
export const KEYMAP_SETTLE_MS = 60;

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
  /** After a call that swaps the keymap, the next call (of this send or the next) waits this long; 0: no wait. */
  readonly settleMs: number;
}

/** `auto`: fjk's behaviour when the mode is known, one character per call otherwise. */
export const chooseDelivery = (mode: KeyboardMode, setting: SplitSetting, gapOverrideMs?: number): Delivery => {
  const policy: SplitPolicy = setting !== 'auto' ? setting : mode === 'minimal' ? 'run' : 'chars';
  const defaultGap = mode === 'minimal' ? 0 : BUFFERED_GAP_MS;
  const gapMs = gapOverrideMs !== undefined && Number.isFinite(gapOverrideMs) ? Math.max(0, gapOverrideMs) : defaultGap;
  return { policy, gapMs, settleMs: mode === 'minimal' ? KEYMAP_SETTLE_MS : 0 };
};
