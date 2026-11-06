// Page side of the sidecar bridge: call the CDP binding `polykeyBridge(json)`; the sidecar answers via
// __polykey.bridgeReply(reply) with the same id. Requests may carry typed text: never log here.

export const BINDING = 'polykeyBridge';
export const DEFAULT_TIMEOUT_MS = 3000;

export interface BridgeReply {
  readonly id: number;
  readonly ok: boolean;
  readonly error?: string;
  readonly [field: string]: unknown;
}

const isReply = (value: unknown): value is BridgeReply =>
  typeof value === 'object'
  && value !== null
  && typeof (value as BridgeReply).id === 'number'
  && typeof (value as BridgeReply).ok === 'boolean';

export const createBridge = (g: Record<string, unknown>) => {
  let nextId = 1;
  const pending = new Map<number, { resolve: (reply: BridgeReply) => void; timer: ReturnType<typeof setTimeout> }>();

  const available = (): boolean => typeof g[BINDING] === 'function';

  const call = (op: string, args: Record<string, unknown> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<BridgeReply> =>
    new Promise((resolve) => {
      const binding = g[BINDING];
      if (typeof binding !== 'function') {
        resolve({ id: 0, ok: false, error: 'no-bridge' });
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ id, ok: false, error: 'timeout' });
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      try {
        (binding as (payload: string) => void)(JSON.stringify({ ...args, id, op }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        resolve({ id, ok: false, error: error instanceof Error ? error.name : typeof error });
      }
    });

  /** Called by the sidecar through window.__polykey.bridgeReply. */
  const receive = (reply: unknown): void => {
    if (!isReply(reply)) return;
    const entry = pending.get(reply.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(reply.id);
    entry.resolve(reply);
  };

  /** Answer every pending request with `closed` (uninstall). */
  const close = (): void => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({ id, ok: false, error: 'closed' });
    }
    pending.clear();
  };

  return { available, call, receive, close };
};
