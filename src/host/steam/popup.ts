// A shadow-root surface inside the stock keyboard popup, so styles never leak either way.

export const SURFACE_ID = 'polykey-root';
/** Bottom strip SteamVR keeps for the keyboard's move bar (280 - 239, measured by fjk). */
export const RESERVED_BOTTOM_PX = 41;

export interface Rect { top: number; left: number; width: number; height: number }

/** Where the keyboard goes: over the stock key panel, or the popup minus the move-bar strip. */
export const overlayRect = (win: Window): Rect => {
  const width = win.innerWidth;
  const height = win.innerHeight;
  const panel = win.document.querySelector('[class*="Layout_"]')?.getBoundingClientRect();
  if (panel && panel.top >= 0 && panel.height >= 120 && panel.bottom <= height) {
    return { top: panel.top, left: panel.left, width: panel.width, height: panel.height };
  }
  return { top: 0, left: 0, width, height: Math.max(0, height - RESERVED_BOTTOM_PX) };
};

export interface Surface {
  readonly win: Window;
  readonly doc: Document;
  readonly host: HTMLElement;
  readonly shadow: ShadowRoot;
  /** Still attached to a live popup document. */
  isLive(): boolean;
  destroy(): void;
}

export const mountSurface = (win: Window): Surface => {
  const doc = win.document;
  // A previous instance whose uninstall failed may have left its host behind.
  doc.getElementById(SURFACE_ID)?.remove();
  const host = doc.createElement('div');
  host.id = SURFACE_ID;
  // The host covers nothing by itself; only what is drawn inside takes pointer input.
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  doc.body.append(host);
  return {
    win,
    doc,
    host,
    shadow,
    isLive: () => host.isConnected && win.closed !== true,
    destroy: () => host.remove(),
  };
};
