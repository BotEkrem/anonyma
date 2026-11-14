import { useEffect, useLayoutEffect } from 'react';
import { placeToolbar } from './toolbarPlacement';

/** Another message under the pointer takes over only after it rests there this long. */
const SWITCH_DELAY_MS = 150;
/** The toolbar stays this long after the pointer leaves its message and the way to it. */
const LEAVE_GRACE_MS = 300;
/** The way from a bubble to its toolbar: the box round both, this much larger. */
const REACH_PAD_PX = 6;
/** Matches the 0.28rem gap the narrow-list CSS leaves above or below the bubble. */
const GAP_PX = 4.5;
/** Keep the toolbar this far inside the list's edges. */
const EDGE_PX = 4;

const SHOWN = '.msg-row[data-hover], .msg-row.menu-open, .msg-row:focus-within';

/** Puts one message's toolbar where it fits inside the visible part of the list. */
function place(list: HTMLElement, row: HTMLElement) {
  const main = row.querySelector<HTMLElement>('.msg-main');
  const bar = row.querySelector<HTMLElement>('.msg-actions');
  if (!main || !bar) return;
  const box = list.getBoundingClientRect();
  const top = box.top + list.clientTop;
  // The top-edge blur covers the first rows once the list has scrolled.
  const scrolled = list.parentElement?.hasAttribute('data-scrolled') ?? false;
  const blur = scrolled
    ? (list.parentElement?.querySelector<HTMLElement>('.gradual-blur')?.offsetHeight ?? 0)
    : 0;
  const m = main.getBoundingClientRect();
  const b = bar.getBoundingClientRect();
  const y = placeToolbar({
    view: { top: top + Math.max(blur, EDGE_PX), bottom: top + list.clientHeight - EDGE_PX },
    main: { top: m.top, bottom: m.bottom },
    height: bar.offsetHeight,
    // Wide lists put it beside the bubble (CSS decides the side), narrow ones above or below.
    beside: b.left >= m.right - 1 || b.right <= m.left + 1,
    preferBelow: row.classList.contains('menu-below'),
    gap: GAP_PX,
  });
  row.style.setProperty('--tb-top', `${y}px`);
  row.setAttribute('data-tb-placed', '');
}

function placeShown(list: HTMLElement) {
  list.querySelectorAll<HTMLElement>(SHOWN).forEach((row) => place(list, row));
}

/**
 * The message action toolbar (reactions, reply, edit, delete).
 *
 * A mouse opens it on the message under the pointer, but with some patience: a
 * neighbouring message the pointer crosses on its way to the toolbar does not
 * take over unless the pointer rests on it, and the toolbar waits a moment after
 * the pointer leaves. (Plain CSS :hover handed it to the neighbour as soon as the
 * pointer left the bubble's own column.) Taps keep the open-on-tap menu
 * (`menuId`). Every shown toolbar is measured into the visible part of the list,
 * so a long message, or one at the list's edge, never puts it off screen.
 *
 * The open message is marked with `data-hover` straight on the DOM: hovering
 * must not re-render the whole list.
 */
export function useMessageToolbar(list: HTMLElement | null, menuId: string | null): void {
  useEffect(() => {
    if (!list) return undefined;
    let active: HTMLElement | null = null;
    let pending: HTMLElement | null = null;
    let switchTimer = 0;
    let closeTimer = 0;
    let frame = 0;
    let point: { x: number; y: number } | null = null;
    /** How far the pointer was from the open toolbar at the previous move. */
    let lastDistance = Infinity;

    const stopSwitch = () => {
      window.clearTimeout(switchTimer);
      switchTimer = 0;
      pending = null;
    };
    const stopClose = () => {
      window.clearTimeout(closeTimer);
      closeTimer = 0;
    };
    const setActive = (row: HTMLElement | null) => {
      if (active === row) return;
      active?.removeAttribute('data-hover');
      active = row;
      lastDistance = Infinity;
      if (row) {
        place(list, row);
        row.setAttribute('data-hover', '');
      }
    };
    const startSwitch = () => {
      window.clearTimeout(switchTimer);
      switchTimer = window.setTimeout(() => {
        const next = pending;
        switchTimer = 0;
        pending = null;
        if (next?.isConnected) setActive(next);
      }, SWITCH_DELAY_MS);
    };
    /** The message (with a toolbar) at this element, if any. */
    const rowAt = (el: Element | null): HTMLElement | null => {
      const row = el?.closest<HTMLElement>('.msg-row');
      if (!row || !list.contains(row) || row.classList.contains('shredding')) return null;
      return row.querySelector('.msg-actions') ? row : null;
    };
    /** The open toolbar's box, and the box round it and its bubble (the way to it). */
    const reach = () => {
      const main = active?.querySelector('.msg-main')?.getBoundingClientRect();
      const bar = active?.querySelector('.msg-actions')?.getBoundingClientRect();
      if (!main || !bar) return null;
      return {
        bar,
        left: Math.min(main.left, bar.left) - REACH_PAD_PX,
        right: Math.max(main.right, bar.right) + REACH_PAD_PX,
        top: Math.min(main.top, bar.top) - REACH_PAD_PX,
        bottom: Math.max(main.bottom, bar.bottom) + REACH_PAD_PX,
      };
    };
    const consider = (el: Element | null) => {
      if (active && !active.isConnected) active = null;
      const row = rowAt(el);
      if (row && row === active) {
        stopSwitch();
        stopClose();
        return;
      }
      const way = point ? reach() : null;
      const p = point;
      const onTheWay =
        way && p
          ? p.x >= way.left && p.x <= way.right && p.y >= way.top && p.y <= way.bottom
          : false;
      // Moving closer to the open toolbar: the pointer is on its way there.
      let approaching = false;
      if (way && p) {
        const dx = Math.max(way.bar.left - p.x, 0, p.x - way.bar.right);
        const dy = Math.max(way.bar.top - p.y, 0, p.y - way.bar.bottom);
        const distance = Math.hypot(dx, dy);
        approaching = distance < lastDistance - 0.5;
        lastDistance = distance;
      }
      if (!row) {
        stopSwitch();
        if (onTheWay) {
          stopClose();
        } else if (active && !closeTimer) {
          closeTimer = window.setTimeout(() => {
            closeTimer = 0;
            setActive(null);
          }, LEAVE_GRACE_MS);
        }
        return;
      }
      stopClose();
      if (!active) {
        setActive(row);
        return;
      }
      // Another message: it takes over once the pointer rests on it, not while
      // the pointer only crosses it on the way to the open toolbar.
      if (pending !== row) {
        pending = row;
        startSwitch();
      } else if (approaching) {
        startSwitch();
      }
    };

    const isMouse = (e: PointerEvent) => e.pointerType === 'mouse' || e.pointerType === 'pen';
    const onMove = (e: PointerEvent) => {
      if (!isMouse(e)) return;
      point = { x: e.clientX, y: e.clientY };
      consider(e.target as Element);
    };
    const onLeave = (e: PointerEvent) => {
      if (!isMouse(e)) return;
      point = null;
      consider(null);
    };
    const refresh = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        // Scrolling moves messages under a still pointer without a pointer event.
        if (point) consider(document.elementFromPoint(point.x, point.y));
        placeShown(list);
      });
    };

    list.addEventListener('pointermove', onMove);
    list.addEventListener('pointerleave', onLeave);
    list.addEventListener('scroll', refresh, { passive: true });
    list.addEventListener('focusin', refresh);
    const resize = new ResizeObserver(refresh);
    resize.observe(list);
    return () => {
      list.removeEventListener('pointermove', onMove);
      list.removeEventListener('pointerleave', onLeave);
      list.removeEventListener('scroll', refresh);
      list.removeEventListener('focusin', refresh);
      resize.disconnect();
      stopSwitch();
      stopClose();
      window.cancelAnimationFrame(frame);
      active?.removeAttribute('data-hover');
    };
  }, [list]);

  // A tap (or click) that opens a message's toolbar: measure it before paint.
  useLayoutEffect(() => {
    if (list && menuId) placeShown(list);
  }, [list, menuId]);
}
