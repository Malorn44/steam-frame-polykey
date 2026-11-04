// The row of choices shown while holding: a key's alternates, an emoji's skin tones. One look and one
// way of picking for both: the choices wear the held-key look, the pick gets the accent, and the pick
// follows the laser's horizontal position (like a phone) while it stays near the row or the held item.

export const HOLD_POPUP_CSS = `
.alts { position: absolute; display: flex; z-index: 2; background: var(--surface); border-radius: var(--radius);
  box-shadow: var(--shadow); }
.alts .key { flex: none; display: flex; align-items: center; justify-content: center; box-sizing: border-box;
  border-radius: var(--radius); background-color: var(--key);
  background-image: linear-gradient(var(--raised), var(--raised)); }
/* The keyboards menu (holding 🌐): the language small above the layout, each on one line. */
.alts.menu .key { flex-direction: column; font-size: var(--ui-title); line-height: 1.1; white-space: nowrap; overflow: hidden; padding: 0 6px; }
.alts.menu .key .lang { font-size: var(--ui-tiny); opacity: 0.75; }
/* Lighten the cell's background only: a filter would also lighten the choice (an emoji's skin tone). */
.alts .key.pick { background-color: var(--accent); background-image: none; color: var(--accent-text); }
`;

export interface HoldPopup {
  /** The picked choice's index, or -1 (moved away: release cancels). */
  readonly pick: number;
  pickAt(x: number, y: number): void;
  close(): void;
}

/**
 * Open a row of `texts` above `held` (below it when there is no room), inside `root`, each cell
 * `size` px. It starts on the cell above the laser at (x, y), so the pick never flashes on the first.
 */
export const openHoldPopup = (
  doc: Document,
  shadow: ShadowRoot,
  root: HTMLElement,
  held: DOMRect,
  texts: readonly string[],
  size: { width: number; height: number },
  start: { x: number; y: number } | null,
  /** Whether moving well away picks nothing (keys); skin tones always keep a pick. */
  cancelable = true,
  /** An extra class for the row ('menu': the keyboards menu). */
  variant = '',
  /** Called when the pick moves onto another choice (not when it opens): for a haptic tick. */
  onPick?: (index: number) => void,
): HoldPopup => {
  const box = root.getBoundingClientRect();
  const el = doc.createElement('div');
  el.className = variant ? `alts ${variant}` : 'alts';
  const cells = texts.map((text) => {
    const cell = doc.createElement('div');
    cell.className = 'key';
    Object.assign(cell.style, { width: `${size.width}px`, height: `${size.height}px` });
    const [top, main] = text.includes('\n') ? text.split('\n') : [null, text];
    if (top !== null) cell.append(Object.assign(doc.createElement('span'), { className: 'lang', textContent: top }));
    cell.append(main ?? '');
    el.append(cell);
    return cell;
  });
  const left = Math.min(Math.max(0, held.left - box.left), Math.max(0, box.width - size.width * texts.length));
  const above = held.top - box.top - size.height - 2;
  Object.assign(el.style, { left: `${left}px`, top: `${above >= 0 ? above : held.bottom - box.top + 2}px` });
  root.append(el);

  let pick = -1;
  let opened = false;
  const setPick = (index: number): void => {
    if (index === pick) return;
    cells[pick]?.classList.remove('pick');
    pick = index;
    cells[index]?.classList.add('pick');
    if (opened && index >= 0) onPick?.(index);
  };
  const pickAt = (x: number, y: number): void => {
    const hits = typeof shadow.elementsFromPoint === 'function' ? shadow.elementsFromPoint(x, y) : [];
    const direct = cells.findIndex((c) => hits.includes(c));
    if (direct >= 0) {
      setPick(direct);
      return;
    }
    const rects = cells.map((c) => c.getBoundingClientRect());
    const first = rects[0];
    if (!first || first.width === 0) return; // not laid out: keep the current pick
    const top = Math.min(first.top, held.top);
    const bottom = Math.max(first.bottom, held.bottom);
    if (cancelable && (y < top - first.height || y > bottom + first.height)) {
      setPick(-1);
      return;
    }
    const index = rects.findIndex((r) => x < r.right);
    setPick(index < 0 ? rects.length - 1 : index);
  };
  setPick(0);
  if (start) pickAt(start.x, start.y);
  opened = true;
  return {
    get pick() { return pick; },
    pickAt,
    close: () => el.remove(),
  };
};
