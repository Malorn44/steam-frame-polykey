// Key presses through SteamClient.Input.ControllerKeyboardSetKeyState (what Steam's own Paste key
// uses). Every pressed key is released in `finally`, on keyboard close and on uninstall.

import type { KeyEvent } from '../../core/keycodes.js';
import type { SteamGlobals } from './globals.js';

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
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

export const createKeySender = ({ getSetKeyState: lookup, sleep = defaultSleep }: KeySenderDeps) => {
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

  /** Send key events in order, `gapMs` apart. Whatever happens, nothing stays pressed. */
  const send = async (events: readonly KeyEvent[], gapMs: number): Promise<KeyResult> => {
    const setKeyState = lookup();
    if (!setKeyState) return { ok: false, sent: 0, error: 'no-key-state-call' };
    release = setKeyState;
    let sent = 0;
    try {
      for (const [code, down] of events) {
        if (sent > 0) await sleep(gapMs);
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
  };

  return { send, releaseAll };
};
