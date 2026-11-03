// A shadow-root surface inside the stock keyboard popup, so styles never leak either way.

export const SURFACE_ID = 'polykey-root';

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
