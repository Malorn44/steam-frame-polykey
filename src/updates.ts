// The update line at the foot of the Settings tab: what the sidecar's updater says (sidecar
// updates.py), and its Check, Install, Restart now and Back buttons. Followed only while the settings
// page shows it, and long-polled while a check, download or restart is under way, or while an installed
// release waits for the keyboard to close.

import type { BridgeReply } from './bridge/client.js';

type Call = (op: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<BridgeReply>;

export interface UpdateStatus {
  readonly rev: number;
  readonly version: string;
  readonly dev: boolean;
  readonly auto: boolean;
  /** installed: an automatic update is current, and restarts into it once the keyboard is hidden. */
  readonly state: 'idle' | 'checking' | 'downloading' | 'installing' | 'installed' | 'restarting';
  /** The newest release the last check found, signed (while installed, the one waiting). */
  readonly latest: string | null;
  /** latest is newer than this one (never on a dev build). */
  readonly available: boolean;
  /** latest was rolled back from: automatic updates leave it until a newer one. */
  readonly skipped: boolean;
  /** Where Back goes: the release before this one (from a dev build, the newest installed). */
  readonly previous?: string;
  readonly error?: string;
  readonly done?: number;
  readonly total?: number;
}

export type UpdateAction = 'check' | 'install' | 'rollback';

const STATES = new Set(['idle', 'checking', 'downloading', 'installing', 'installed', 'restarting']);
const WAIT_MS = 15_000;

export const parseUpdate = (reply: BridgeReply): UpdateStatus | null => {
  const r = reply as Record<string, unknown>;
  if (!reply.ok || typeof r.rev !== 'number' || typeof r.version !== 'string' || typeof r.state !== 'string' || !STATES.has(r.state)) return null;
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v.length <= 64 ? v : undefined);
  const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const previous = text(r.previous);
  const error = text(r.error);
  const done = count(r.done);
  const total = count(r.total);
  return {
    rev: r.rev, version: r.version, dev: r.dev === true, auto: r.auto !== false, state: r.state as UpdateStatus['state'],
    latest: text(r.latest) ?? null, available: r.available === true, skipped: r.skipped === true,
    ...(previous ? { previous } : {}), ...(error ? { error } : {}),
    ...(done !== undefined ? { done } : {}), ...(total !== undefined ? { total } : {}),
  };
};

const busy = (s: UpdateStatus): boolean => s.state !== 'idle';

const ERRORS: Record<string, string> = {
  network: 'Couldn\'t reach the release server',
  'no-release': 'No release found',
  'bad-signature': 'The latest release isn\'t signed with polykey\'s key, so it wasn\'t installed',
  'bad-manifest': 'The release information isn\'t valid',
  'bad-host': 'The release points somewhere it shouldn\'t',
  'no-key': 'This build has no release key, so it can\'t update',
  'no-verifier': 'ssh-keygen is missing, so releases can\'t be checked',
  'bad-hash': 'The download was damaged; try again',
  'bad-size': 'The download was damaged; try again',
  'bad-archive': 'The release couldn\'t be unpacked',
  'no-space': 'Not enough space for the update',
  disk: 'The update couldn\'t be written',
  'restart-needed': 'Installed; it starts with polykey\'s next restart',
  busy: 'Another install or update of polykey is under way; try again in a minute',
  'no-previous': 'There is no earlier release to go back to',
};

/** The line's text and its buttons, from the updater's status (null: not known yet). */
export const updateSummary = (s: UpdateStatus | null): { text: string; actions: { action: UpdateAction; label: string }[] } => {
  if (!s) return { text: '', actions: [] };
  const back = s.previous ? [{ action: 'rollback' as const, label: s.dev ? `Use release ${s.previous}` : `Back to ${s.previous}` }] : [];
  const check = { action: 'check' as const, label: 'Check for updates' };
  if (s.state === 'checking') return { text: 'Checking for updates…', actions: [] };
  if (s.state === 'downloading') {
    const pct = s.total ? Math.floor(((s.done ?? 0) * 100) / s.total) : 0;
    return { text: `Downloading ${s.latest ?? 'the update'}… ${pct}%`, actions: [] };
  }
  if (s.state === 'installing') return { text: `Installing ${s.latest ?? 'the update'}…`, actions: [] };
  if (s.state === 'restarting') return { text: 'Restarting polykey…', actions: [] };
  // Restart now asks for the waiting release by name, which the sidecar takes as "restart at once".
  if (s.state === 'installed') {
    return {
      text: `${s.latest ?? 'The update'} is installed; it starts when the keyboard closes`,
      actions: [...(s.latest ? [{ action: 'install' as const, label: 'Restart now' }] : []), ...back],
    };
  }
  if (s.error) return { text: ERRORS[s.error] ?? `Update failed (${s.error})`, actions: [check, ...back] };
  if (s.dev) return { text: `Dev build: no updates${s.latest ? ` · latest release ${s.latest}` : ''}`, actions: [check, ...back] };
  if (s.available && s.latest) {
    return {
      text: s.skipped ? `${s.latest} is available (you went back from it)` : `${s.latest} is available`,
      actions: [{ action: 'install', label: `Install ${s.latest}` }, ...back],
    };
  }
  return { text: s.latest ? 'Up to date' : '', actions: [check, ...back] };
};

export interface Updates {
  readonly status: UpdateStatus | null;
  /** Ask for the status, and keep asking while something is under way. */
  follow(): void;
  run(action: UpdateAction): void;
}

export const createUpdates = ({ call, active, onStatus, warn }: {
  call: Call;
  /** Whether to ask: the bridge is there and the line is on screen. */
  active: () => boolean;
  onStatus: (status: UpdateStatus) => void;
  warn: (line: string) => void;
}): Updates => {
  let status: UpdateStatus | null = null;
  let following = false;
  let again = false;

  const show = (next: UpdateStatus): void => {
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
      let since: number | undefined;
      for (;;) {
        const next = parseUpdate(await call('update.status', since === undefined ? {} : { since, timeoutMs: WAIT_MS }, WAIT_MS + 5000));
        if (next) show(next);
        const more = again;
        again = false;
        if (!active() || !next || (!busy(next) && !more)) break;
        since = more ? undefined : next.rev;
      }
      following = false;
    })();
  };

  const run = (action: UpdateAction): void => {
    const op = action === 'check' ? 'update.check' : action === 'install' ? 'update.install' : 'update.rollback';
    const args = action === 'install' && status?.latest ? { version: status.latest } : {};
    void call(op, args).then((reply) => {
      const next = parseUpdate(reply);
      if (next) show(next);
      else if (typeof reply.error === 'string') warn(`update: ${reply.error}`);
      follow();
    });
  };

  return { get status() { return status; }, follow, run };
};
