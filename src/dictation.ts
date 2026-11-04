// Dictation on the page. The mic key starts listening and a second press stops it; the sidecar also
// ends a session after a pause (sidecar/polykey/speech/session.py). A continuous session (Settings →
// Dictation) listens until the mic is pressed again, each pause handing over one phrase, in order. Phases
// come from dictation.wait, which the sidecar answers when one changes or when there is news (a speech
// level for the mic key's bars, a phrase recognized), so nothing polls. The engine's and models' state
// is followed the same way, and only while something downloads. Texts go to onText and onPhrase only:
// never logged; failures are logged as their codes.

import type { BridgeReply } from './bridge/client.js';
import { downloading, micDownload, parseCatalog, parseStatus, type MicState, type SpeechCatalog, type SpeechStatus } from './core/dictation.js';

type Call = (op: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<BridgeReply>;

const WAIT_MS = 15_000;
const START_TIMEOUT_MS = 5000;
/** How long the mic key shows a failure. */
export const ERROR_MS = 2500;
/**
 * The longest a session may take on the page (listening ≤ 33 s, loading ≤ 30 s, recognizing ≤ 60 s);
 * past it the mic gives up and comes back, whatever the sidecar does.
 */
export const MAX_SESSION_MS = 150_000;
/** How long a dictation.status waits for the next change while something downloads. */
const STATUS_WAIT_MS = 15_000;

export interface Dictation {
  /** The mic key pressed: start listening in `language`, stop listening, or give up on a recognition. */
  toggle(language: string): void;
  /** Drop a session under way (the keyboard closed or changed); its text never arrives. */
  cancel(): void;
  state(): MicState;
}

export const createDictation = ({
  call, onState, onText, log, onLevels = () => {}, onListening = () => {}, onError = () => {},
  continuous = () => false, onPhrase = () => {}, onRecognizing = () => {}, onEnd = () => {},
}: {
  call: Call; onState: (state: MicState) => void; onText: (text: string) => void; log: (line: string) => void;
  /** Whether a new session is continuous (read at each start). */
  continuous?: () => boolean;
  /** A continuous session's phrases, in order, as each is recognized. */
  onPhrase?: (text: string) => void;
  /** Whether a phrase is being recognized while a continuous session listens on. */
  onRecognizing?: (recognizing: boolean) => void;
  /** A continuous session ended by itself or by the mic (not cancelled), after its last phrase. */
  onEnd?: () => void;
  /** The last five speech levels while listening (0..8, oldest first). */
  onLevels?: (levels: number[]) => void;
  /** Listening started (true) or stopped (false), whatever ended it; once per session. */
  onListening?: (listening: boolean) => void;
  /** A failure's code, after it is shown (no-model: nothing downloaded serves the language). */
  onError?: (code: string) => void;
}): Dictation => {
  let state: MicState = 'idle';
  /** The sidecar's session id; 0 while starting or idle. */
  let session = 0;
  /** Whether the session under way is continuous. */
  let continuing = false;
  let errorTimer: ReturnType<typeof setTimeout> | null = null;

  const set = (next: MicState, code?: string): void => {
    if (errorTimer !== null) clearTimeout(errorTimer);
    errorTimer = null;
    const was = state;
    state = next;
    if (next === 'error') {
      log(`dictation: ${code ?? '?'}`);
      errorTimer = setTimeout(() => { errorTimer = null; set('idle'); }, ERROR_MS);
    }
    onState(next);
    if ((was === 'listening') !== (next === 'listening')) onListening(next === 'listening');
    if (next === 'error') onError(code ?? '?');
  };

  /** Back to idle, with the error shown, unless the session moved on meanwhile. */
  const fail = (id: number, code: string | undefined): void => {
    if (id !== session) return;
    session = 0;
    set('error', code);
  };

  const follow = async (id: number): Promise<void> => {
    try {
      await phases(id);
    } catch (error) {
      fail(id, error instanceof Error ? error.name : 'page-error'); // never left listening or transcribing
    }
  };

  const phases = async (id: number): Promise<void> => {
    let phase = 'listening';
    let seq = -1; // the sidecar's count of news sent; it answers once there is newer
    let recognizing = false;
    // A session that still shows signs of life (news, a new phase) gets more time; a silent one gives up.
    let deadline = Date.now() + MAX_SESSION_MS;
    while (id === session) {
      if (Date.now() > deadline) {
        void call('dictation.cancel');
        fail(id, 'page-timeout');
        return;
      }
      const reply = await call('dictation.wait', { session: id, phase, seq, timeoutMs: WAIT_MS }, WAIT_MS + 5000);
      if (id !== session) return;
      if (!reply.ok) {
        if (reply.error === 'timeout') continue;
        fail(id, reply.error);
        return;
      }
      if (reply['phase'] !== phase || reply['seq'] !== seq) deadline = Date.now() + MAX_SESSION_MS;
      phase = String(reply['phase']);
      if (typeof reply['seq'] === 'number') seq = reply['seq'];
      if (Array.isArray(reply['texts'])) for (const text of reply['texts']) if (typeof text === 'string' && text) onPhrase(text);
      if (typeof reply['recognizing'] === 'boolean' && reply['recognizing'] !== recognizing) {
        recognizing = reply['recognizing'];
        onRecognizing(recognizing);
      }
      if (phase === 'listening') {
        if (Array.isArray(reply['bars'])) onLevels(reply['bars'].map(Number));
        continue;
      }
      if (phase === 'transcribing') {
        if (state !== 'transcribing') set('transcribing');
        continue;
      }
      if (recognizing) onRecognizing(false);
      if (phase === 'error') {
        fail(id, String(reply['error']));
        if (continuing) onEnd();
        return;
      }
      session = 0; // done, or cancelled
      set('idle');
      const text = reply['text'];
      if (phase === 'done' && typeof text === 'string' && text) onText(text);
      if (phase === 'done' && continuing) onEnd();
    }
  };

  const start = async (language: string): Promise<void> => {
    set('listening'); // at once, so the press shows
    continuing = continuous();
    const reply = await call('dictation.start', { language, ...(continuing ? { continuous: true } : {}) }, START_TIMEOUT_MS);
    if (state !== 'listening' || session !== 0) return; // cancelled meanwhile
    if (!reply.ok || typeof reply['session'] !== 'number') {
      set('error', reply.error);
      return;
    }
    session = reply['session'];
    void follow(session);
  };

  return {
    toggle: (language) => {
      if (state === 'listening') {
        if (session) void call('dictation.stop', { session });
      } else if (state === 'transcribing') {
        // Pressed while recognizing: give up on it, so a stuck recognition never holds the mic.
        session = 0;
        void call('dictation.cancel');
        log('dictation: cancelled');
        set('idle');
      } else void start(language);
    },
    cancel: () => {
      if (state === 'idle') return;
      if (state !== 'error') void call('dictation.cancel');
      session = 0;
      set('idle');
    },
    state: () => state,
  };
};

/** The speech engine's and models' state, as the Dictation tab and the mic key show it. */
export interface SpeechModels {
  /** null until the sidecar answers. */
  readonly catalog: SpeechCatalog | null;
  /** null until the sidecar answers, and again once dictation is turned off. */
  readonly status: SpeechStatus | null;
  /** Fetch the catalogue (once) and the status, then follow the status while anything downloads. */
  follow(): void;
  /** Download the engine, and the model if named. */
  download(modelId?: string): void;
  /** Delete a model, or stop its download. */
  delete(modelId: string): void;
  /** Use `modelId` for `language` from now on (settings.json "dictationModels"). */
  choose(language: string, modelId: string): void;
  /** Dictation turned off: no download shows on the mic. */
  forget(): void;
  /** The share of a download the mic key waits for in `language`, or null (micDownload). */
  progress(language: string): number | null;
}

export const createSpeechModels = ({ call, active, onCatalog, onStatus, warn }: {
  call: Call;
  /** Whether to ask the sidecar at all: dictation on, and the bridge there. */
  active: () => boolean;
  /** The catalogue arrived. */
  onCatalog: () => void;
  /** A new status from the sidecar. */
  onStatus: (status: SpeechStatus) => void;
  warn: (line: string) => void;
}): SpeechModels => {
  let catalog: SpeechCatalog | null = null;
  let status: SpeechStatus | null = null;
  let following = false;
  /** Asked to follow while already following: a download may have started since the last answer. */
  let again = false;

  const show = (next: SpeechStatus): void => {
    status = next;
    onStatus(next);
  };

  const follow = (): void => {
    if (!active()) return;
    if (following) {
      again = true;
      return;
    }
    following = true;
    void (async () => {
      if (!catalog) {
        catalog = parseCatalog(await call('dictation.catalog'));
        if (catalog) onCatalog();
      }
      let since: number | undefined;
      for (;;) {
        const reply = await call('dictation.status', since === undefined ? {} : { since, timeoutMs: STATUS_WAIT_MS }, STATUS_WAIT_MS + 5000);
        const next = parseStatus(reply);
        if (next) show(next);
        const more = again;
        again = false;
        if (!active() || !next || (!downloading(next) && !more)) break;
        since = more ? undefined : next.rev;
      }
      following = false;
    })();
  };

  /** A reply carrying the status (download, delete): shown, and followed while something downloads. */
  const after = (reply: BridgeReply): void => {
    const next = parseStatus(reply);
    if (next) show(next);
    else if (typeof reply.error === 'string') warn(`dictation: ${reply.error}`);
    follow();
  };

  return {
    get catalog() { return catalog; },
    get status() { return status; },
    follow,
    download: (modelId) => { void call('dictation.download', modelId ? { model: modelId } : {}).then(after); },
    delete: (modelId) => { void call('dictation.delete', { model: modelId }).then(after); },
    choose: (language, modelId) => {
      const choices = { ...status?.choices, [language]: modelId };
      if (status) status = { ...status, choices };
      void call('settings.save', { settings: { dictationModels: choices } }).then((reply) => {
        if (!reply.ok) warn(`settings not saved: ${reply.error ?? '?'}`);
      });
    },
    forget: () => { status = null; },
    progress: (language) => micDownload(catalog, status, language),
  };
};
