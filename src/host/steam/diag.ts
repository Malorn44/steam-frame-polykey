// Read-only VR keyboard status (open, buffered/minimal, target overlay). Optional: without the store,
// diagnostics are off and nothing else changes.

import type { KeyboardMode } from '../../core/output/plan.js';
import type { SteamGlobals } from './globals.js';

/** Fields seen on the status object by fjk and TaiKeid. */
export interface VRKeyboardStatus {
  bIsOpen?: unknown;
  bMinimal?: unknown;
  sOverlayKey?: unknown;
  unAppID?: unknown;
  bDispatchEventsToSteamVR?: unknown;
}

export interface StatusStore {
  readonly VRKeyboardStatus: VRKeyboardStatus;
}

type TargetKind = 'streamed' | 'local-app' | 'steam-ui' | 'unknown';

type WebpackRequire = ((id: string) => unknown) & { m: Record<string, unknown> };

/** webpack's require, from pushing a chunk with an unknown id onto Steam's registry; no module runs. */
export const getWebpackRequire = (g: SteamGlobals): WebpackRequire | null => {
  try {
    const registry = g['webpackChunksteamui'] as { push?: (chunk: unknown) => unknown } | undefined;
    if (typeof registry?.push !== 'function') return null;
    let found: WebpackRequire | null = null;
    registry.push([
      [Symbol('polykey')],
      {},
      (req: WebpackRequire) => {
        found = req;
      },
    ]);
    const req = found as WebpackRequire | null;
    return req && typeof req === 'function' && typeof req.m === 'object' ? req : null;
  } catch {
    return null;
  }
};

/** The store with a `VRKeyboardStatus` getter; only modules mentioning it are required. */
export const findStatusStore = (g: SteamGlobals): StatusStore | null => {
  const req = getWebpackRequire(g);
  if (!req) return null;
  for (const id of Object.keys(req.m)) {
    try {
      if (!String(req.m[id]).includes('get VRKeyboardStatus()')) continue;
      const exports = req(id);
      if (typeof exports !== 'object' || exports === null) continue;
      for (const value of Object.values(exports)) {
        if (typeof value !== 'object' || value === null || !('VRKeyboardStatus' in value)) continue;
        const status = (value as StatusStore).VRKeyboardStatus;
        if (status && typeof status.bIsOpen === 'boolean') return value as StatusStore;
      }
    } catch {
      // Keep looking.
    }
  }
  return null;
};

/** Read the status without letting a throwing getter escape. */
export const readStatus = (store: StatusStore | null): VRKeyboardStatus | null => {
  try {
    return store?.VRKeyboardStatus ?? null;
  } catch {
    return null;
  }
};

export const keyboardMode = (status: VRKeyboardStatus | null): KeyboardMode => {
  if (!status || status.bIsOpen !== true || typeof status.bMinimal !== 'boolean') return 'unknown';
  return status.bMinimal ? 'minimal' : 'buffered';
};

/** Target kind from the overlay key (bDispatchEventsToSteamVR is true even for Steam's own UI). */
export const classifyTarget = (status: VRKeyboardStatus | null): TargetKind => {
  if (status?.bIsOpen !== true) return 'unknown';
  const key = typeof status.sOverlayKey === 'string' ? status.sOverlayKey : '';
  if (key.startsWith('steamlink')) return 'streamed';
  if (key.startsWith('gamescope.')) return 'local-app';
  if (key.startsWith('valve.steam.')) return 'steam-ui';
  return 'unknown';
};

/** One log-safe line about the keyboard's state. Only whitelisted, non-text fields. */
export const describeStatus = (status: VRKeyboardStatus | null): string => {
  if (!status) return 'status=unavailable';
  const overlay = typeof status.sOverlayKey === 'string' && status.sOverlayKey ? status.sOverlayKey.slice(0, 80) : '-';
  const app = typeof status.unAppID === 'number' ? status.unAppID : '-';
  const flag = (v: unknown) => (typeof v === 'boolean' ? String(v) : '?');
  return [
    `open=${flag(status.bIsOpen)}`,
    `mode=${keyboardMode(status)}`,
    `target=${classifyTarget(status)}`,
    `overlay=${overlay}`,
    `app=${app}`,
    `dispatchToSteamVR=${flag(status.bDispatchEventsToSteamVR)}`,
  ].join(' ');
};
