import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

export interface LongPressHandlers {
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
  onTouchMove: () => void;
}

// MOVE_THRESHOLD_PX is how far a pointer can drift from its pointerdown
// origin before a pending long-press is treated as a scroll/drag instead
// (fix round 1, finding 3: a scroll gesture starting on a card used to
// keep the timer alive and pop the action sheet mid-scroll).
export const MOVE_THRESHOLD_PX = 10;

// exceedsMoveThreshold is the pure decision the hook's pointermove handler
// makes — extracted so the threshold logic is unit-testable without
// simulating real DOM pointer events.
export function exceedsMoveThreshold(dx: number, dy: number, thresholdPx = MOVE_THRESHOLD_PX): boolean {
  return Math.hypot(dx, dy) > thresholdPx;
}

// useLongPress drives the card's "долгий тап → action sheet" affordance
// (06-ui.md §Люди). Pointer events cover touch and mouse alike.
//
// Cancellation covers every way a press can stop being "just holding
// still": pointerup/leave/cancel (unchanged from the original
// implementation), pointermove/touchmove beyond MOVE_THRESHOLD_PX (a
// finger sliding to scroll the list), and — since `scroll` does not bubble
// in the DOM, so a card-level onScroll prop would never see the page's own
// scroll container scrolling — a capture-phase `window` scroll listener
// for the lifetime of the hook (a no-op clearTimer() call when no timer is
// pending).
//
// A `click` event still fires right after the pointerup that ends a long
// press (browser default), which would otherwise also trigger the card's
// own tap -> navigate handler — `consume()` reports whether the
// just-finished press was a completed long press so the caller can
// swallow that one click.
export function useLongPress(onLongPress: () => void, delayMs = 500): {
  handlers: LongPressHandlers;
  consume: () => boolean;
} {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const origin = useRef<{ x: number; y: number } | null>(null);

  function clearTimer() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  }

  useEffect(() => {
    // Capture phase: `scroll` doesn't bubble, so this is the only way to
    // observe an ancestor scroll container (or the page itself) moving
    // while a press is pending, regardless of which element scrolled.
    window.addEventListener("scroll", clearTimer, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", clearTimer, { capture: true });
  }, []);

  function onPointerDown(e: ReactPointerEvent) {
    fired.current = false;
    origin.current = { x: e.clientX, y: e.clientY };
    timer.current = setTimeout(() => {
      fired.current = true;
      onLongPress();
    }, delayMs);
  }

  function onPointerMove(e: ReactPointerEvent) {
    if (!origin.current) return;
    if (exceedsMoveThreshold(e.clientX - origin.current.x, e.clientY - origin.current.y)) {
      clearTimer();
    }
  }

  function consume(): boolean {
    const was = fired.current;
    fired.current = false;
    return was;
  }

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: clearTimer,
      onPointerLeave: clearTimer,
      onPointerCancel: clearTimer,
      // Defensive redundancy alongside pointermove: some mobile browsers'
      // pointer-event/touch-event interplay during scroll gesture
      // recognition is inconsistent enough that a plain touchmove is worth
      // treating as "moving" too, even without measuring its distance.
      onTouchMove: clearTimer,
    },
    consume,
  };
}
