import { useRef, type PointerEvent as ReactPointerEvent } from "react";

// The ONE baseline gesture this UI allows (spec §16.2): a horizontal swipe
// inside the hero/selector region moves to the next or previous entity.
//
// Everything §16.2 constrains is a constant here rather than a prop, because
// the constraints are the spec, not a per-page preference:
//
//   * it is bounded — the handlers are attached to the hero region, never
//     to the page (§16.2's last bullet);
//   * a drag that starts in the first 24 px of the left edge is ignored, so
//     the system Back gesture is never shadowed;
//   * vertical movement wins — the page scrolls and the swipe is abandoned,
//     which is what stops a gesture from stealing a scroll;
//   * ~56 px of horizontal travel is required before anything happens;
//   * and it is an accelerator only: EntityPager renders the visible
//     previous/next buttons §16.1 and §21 make mandatory.

/** §16.2: a drag starting this close to the left edge belongs to the OS. */
export const SWIPE_EDGE_DEAD_ZONE_PX = 24;
/** §16.2: recommended horizontal travel before a swipe counts. */
export const SWIPE_THRESHOLD_PX = 56;
/** Vertical travel that abandons the gesture in favour of scrolling. */
export const SWIPE_VERTICAL_CANCEL_PX = 12;

export type SwipeVerdict = "next" | "previous" | "none";

/**
 * What a completed drag of (dx, dy) means. Vertical priority is decided
 * here too: a drag that moved further down the screen than across it is
 * never a swipe, however far it travelled horizontally.
 */
export function swipeVerdict(dx: number, dy: number): SwipeVerdict {
  if (Math.abs(dy) > Math.abs(dx)) return "none";
  if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return "none";
  // Swipe LEFT (a negative dx) pulls the next entity in from the right.
  return dx < 0 ? "next" : "previous";
}

/** §16.2: a gesture starting in the left edge strip is the system's, not ours. */
export function startsInEdgeDeadZone(clientX: number): boolean {
  return clientX <= SWIPE_EDGE_DEAD_ZONE_PX;
}

/** True once the drag has committed to the vertical axis. */
export function abandonsForScroll(dx: number, dy: number): boolean {
  return Math.abs(dy) > SWIPE_VERTICAL_CANCEL_PX && Math.abs(dy) > Math.abs(dx);
}

export interface BoundedSwipeOptions {
  onNext: () => void;
  onPrevious: () => void;
  /** Off in the layouts where the pager is the only sensible control. */
  enabled?: boolean;
}

export interface BoundedSwipeHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
}

interface SwipeStart {
  pointerId: number;
  x: number;
  y: number;
}

// useBoundedSwipe returns the four pointer handlers to spread onto the ONE
// element that may carry the gesture. It keeps the drag origin in a ref
// rather than in state: a swipe in progress changes nothing on screen (the
// entity only changes when it completes), so re-rendering on every
// pointermove would be pure cost.
export function useBoundedSwipe({
  onNext,
  onPrevious,
  enabled = true,
}: BoundedSwipeOptions): BoundedSwipeHandlers {
  const start = useRef<SwipeStart | null>(null);

  return {
    onPointerDown: (event) => {
      start.current = null;
      if (!enabled) return;
      // Touch and pen only. A mouse has the pager buttons, and a drag with
      // a mouse is a text selection.
      if (event.pointerType === "mouse") return;
      if (startsInEdgeDeadZone(event.clientX)) return;
      start.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    },
    onPointerMove: (event) => {
      const origin = start.current;
      if (!origin || origin.pointerId !== event.pointerId) return;
      if (abandonsForScroll(event.clientX - origin.x, event.clientY - origin.y)) {
        start.current = null;
      }
    },
    onPointerUp: (event) => {
      const origin = start.current;
      start.current = null;
      if (!origin || origin.pointerId !== event.pointerId) return;
      const verdict = swipeVerdict(event.clientX - origin.x, event.clientY - origin.y);
      if (verdict === "next") onNext();
      else if (verdict === "previous") onPrevious();
    },
    onPointerCancel: () => {
      start.current = null;
    },
  };
}
