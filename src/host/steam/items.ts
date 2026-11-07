// The user's own Steam chat items (emoticons, stickers, room effects) from Steam's emoticon store, and
// their image URLs on Steam's community CDN. Read-only; empty lists when Steam has none or moved them.

import type { SteamItem } from '../../core/emoji.js';
import type { SteamGlobals } from './globals.js';

const FALLBACK_CDN = 'https://community.steamstatic.com/';
let cdn: string | undefined;

/** Steam's COMMUNITY_CDN_URL (found once in its webpack config), or the known default. */
const communityCdn = (g: SteamGlobals): string => {
  if (cdn) return cdn;
  cdn = FALLBACK_CDN;
  try {
    const registry = g['webpackChunksteamui'] as { push?: (chunk: unknown) => unknown } | undefined;
    let req: (((id: string) => unknown) & { m: Record<string, unknown> }) | null = null;
    registry?.push?.([[Symbol('polykey-cdn')], {}, (r: typeof req) => { req = r; }]);
    const found = req as (((id: string) => unknown) & { m: Record<string, unknown> }) | null;
    for (const id of Object.keys(found?.m ?? {})) {
      if (!String(found!.m[id]).includes('COMMUNITY_CDN_URL:')) continue;
      for (const value of Object.values(found!(id) ?? {})) {
        const url = (value as { COMMUNITY_CDN_URL?: unknown } | null)?.COMMUNITY_CDN_URL;
        if (typeof url === 'string' && /^https:\/\//.test(url)) return (cdn = url);
      }
    }
  } catch {
    // Keep the default.
  }
  return cdn;
};

/** Steam's chat item store (g_FriendsUIApp.ChatStore.EmoticonStore), if it is there. */
const itemStore = (g: SteamGlobals): Record<string, unknown> | undefined => {
  try {
    return (g['g_FriendsUIApp'] as { ChatStore?: { EmoticonStore?: Record<string, unknown> } } | undefined)
      ?.ChatStore?.EmoticonStore;
  } catch {
    return undefined;
  }
};

export const steamItemsAvailable = (g: SteamGlobals): boolean => !!itemStore(g);

/**
 * Ask Steam for the user's items as its own keyboard's picker does: Steam fetches them once a session,
 * lazily, and ignores the ask once they are in or while its request is out. True while they are on
 * their way (false when they are in, or Steam's store or its loader is missing).
 */
export const loadSteamItems = (g: SteamGlobals): boolean => {
  try {
    const store = itemStore(g);
    if (typeof store?.['UpdateEmoticonList'] !== 'function') return false;
    (store['UpdateEmoticonList'] as () => void)(); // on the store: Steam's loader uses `this`
    return (store['is_initialized'] ?? store['m_bInitialized']) === false;
  } catch {
    return false;
  }
};

export const steamItems = (g: SteamGlobals): SteamItem[] => {
  try {
    const store = itemStore(g);
    const names = (key: string): string[] => {
      const list = store?.[key];
      return Array.isArray(list) ? list.map((i) => (i as { name?: unknown })?.name).filter((n): n is string => typeof n === 'string') : [];
    };
    return [
      ...names('m_rgEmoticons').map((name): SteamItem => ({ kind: 'emoticon', name })),
      ...names('m_rgStickers').map((name): SteamItem => ({ kind: 'sticker', name })),
      ...names('m_rgEffects').map((name): SteamItem => ({ kind: 'effect', name })),
    ];
  } catch {
    return [];
  }
};

/** An item's picture, as Steam's keyboard shows it (effects have none: their name is shown). */
export const steamItemImage = (g: SteamGlobals, item: SteamItem): string | null =>
  item.kind === 'emoticon' ? `${communityCdn(g)}economy/emoticonlarge/${encodeURIComponent(item.name)}`
    : item.kind === 'sticker' ? `${communityCdn(g)}economy/sticker/${encodeURIComponent(item.name)}`
      : null;
