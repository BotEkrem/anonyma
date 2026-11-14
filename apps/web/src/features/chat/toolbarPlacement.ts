/** A vertical span in viewport pixels. */
export interface Span {
  top: number;
  bottom: number;
}

export interface ToolbarPlacement {
  /** The part of the message list a person can see (below the top-edge blur). */
  view: Span;
  /** The message body the toolbar belongs to (`.msg-main`). */
  main: Span;
  /** The toolbar's height. */
  height: number;
  /** Wide list: the toolbar sits beside the bubble. Narrow list: above or below it. */
  beside: boolean;
  /** Narrow list: try below the bubble first (the first message of a run). */
  preferBelow: boolean;
  /** Space between the bubble and a toolbar above or below it. */
  gap: number;
}

/**
 * Where a message's action toolbar goes, as its top relative to the top of the
 * message body. It always lands inside the visible part of the list: beside a
 * long message it centres on the part of the bubble that is on screen; above or
 * below a message it takes the side that fits, and when neither fits (a message
 * taller than the list) it sits on the bubble at the edge of the list.
 */
export function placeToolbar({
  view,
  main,
  height,
  beside,
  preferBelow,
  gap,
}: ToolbarPlacement): number {
  const lowest = view.top;
  const highest = view.bottom - height;
  let y: number;
  if (beside) {
    const shownTop = Math.max(main.top, view.top);
    const shownBottom = Math.min(main.bottom, view.bottom);
    const middle =
      shownBottom > shownTop ? (shownTop + shownBottom) / 2 : (main.top + main.bottom) / 2;
    y = middle - height / 2;
  } else {
    const above = main.top - gap - height;
    const below = main.bottom + gap;
    const order = preferBelow ? [below, above] : [above, below];
    y = order.find((c) => c >= lowest && c <= highest) ?? order[0]!;
  }
  if (highest >= lowest) y = Math.min(Math.max(y, lowest), highest);
  return Math.round(y - main.top);
}
