// Keeps Steam's own keyboard quiet under ours. It stays mounted underneath and holds gamepad focus,
// so controller buttons (custom vgp_* DOM events on its focused key) would type behind our back.
// While active: those events are swallowed in the capture phase (except B, Select, Start, Steam and
// Quick Access), and the stock key panel is made transparent and click-through. (Same as fjk 0.9.1.)

const PASS_THROUGH_BUTTONS = new Set([2, 13, 14, 27, 28]);
const BUTTON_EVENTS = ['vgp_onbuttondown', 'vgp_onbuttonup'];
const LOGICAL_EVENTS = ['vgp_onok', 'vgp_onsecondaryaction', 'vgp_onoptions', 'vgp_ondirection'];
const STYLE_ID = 'polykey-stock-guard';
const CSS = '[role="grid"], [class*="Layout_"] { opacity: 0 !important; pointer-events: none !important; }';

export const shouldSwallow = (type: string, detail: { button?: unknown } | null | undefined): boolean =>
  LOGICAL_EVENTS.includes(type) || (BUTTON_EVENTS.includes(type) && !PASS_THROUGH_BUTTONS.has(detail?.button as number));

export const createStockGuard = (win: Window) => {
  const doc = win.document;
  const swallow = (e: Event): void => {
    if (!shouldSwallow(e.type, (e as CustomEvent).detail)) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  };
  let active = false;
  const setActive = (value: boolean): void => {
    if (value === active) return;
    active = value;
    for (const type of [...BUTTON_EVENTS, ...LOGICAL_EVENTS]) {
      if (value) win.addEventListener(type, swallow, true);
      else win.removeEventListener(type, swallow, true);
    }
    if (value) {
      const style = doc.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      doc.head?.append(style);
    } else {
      doc.getElementById(STYLE_ID)?.remove();
    }
  };
  return { setActive };
};
