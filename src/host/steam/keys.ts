// Key presses through SteamClient.Input.ControllerKeyboardSetKeyState (what Steam's own Paste key
// uses). Every pressed key is released in `finally`, on keyboard close and on uninstall.

import type { KeyEvent } from '../../core/keycodes.js';
import type { SteamGlobals } from './globals.js';
import { createPacer, type Pacer } from './pace.js';

export type SetKeyState = (code: number, down: boolean) => void;

export const getSetKeyState = (g: SteamGlobals): SetKeyState | null => {
  try {
    const input = (g['SteamClient'] as { Input?: Record<string, unknown> } | undefined)?.Input;
    const fn = input?.['ControllerKeyboardSetKeyState'];
    return typeof fn === 'function' ? (code, down) => (fn as SetKeyState).call(input, code, down) : null;
  } catch {
    return null;
  }
};

export interface KeyResult {
  readonly ok: boolean;
  readonly sent: number;
  readonly error?: string;
}

interface KeySenderDeps {
  readonly getSetKeyState: () => SetKeyState | null;
  /** Shared with the text sender: a chord goes after the text queued before it, once its keymap settled (pace.ts). */
  readonly pacer?: Pacer;
}

export const createKeySender = ({ getSetKeyState: lookup, pacer = createPacer() }: KeySenderDeps) => {
  const held = new Set<number>();
  let release: SetKeyState | null = null;

  /** Release every key still held, last pressed first. Safe to call any time. */
  const releaseAll = (): void => {
    const codes = [...held].reverse();
    held.clear();
    for (const code of codes) {
      try {
        release?.(code, false);
      } catch {
        // Nothing more to do; the next send releases again.
      }
    }
  };

  /**
   * Send key events in order, `gapMs` apart. Whatever happens, nothing stays pressed. A keymap still
   * settling is waited out before the first press, never with a key held.
   */
  const send = (events: readonly KeyEvent[], gapMs: number): Promise<KeyResult> => pacer.run(async () => {
    const setKeyState = lookup();
    if (!setKeyState) return { ok: false, sent: 0, error: 'no-key-state-call' };
    release = setKeyState;
    let sent = 0;
    try {
      for (const [code, down] of events) {
        await pacer.ready(sent > 0 ? gapMs : 0, 'chord');
        if (down) held.add(code);
        setKeyState(code, down);
        if (!down) held.delete(code);
        sent += 1;
      }
      return { ok: true, sent };
    } catch (error) {
      return { ok: false, sent, error: error instanceof Error ? error.name : typeof error };
    } finally {
      releaseAll();
    }
  });

  return { send, releaseAll };
};
