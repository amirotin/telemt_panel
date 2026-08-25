import { useRef } from "react";

export interface LongPressHandlers {
  onPointerDown: () => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
}

// useLongPress drives the card's "долгий тап → action sheet" affordance
// (06-ui.md §Люди). Pointer events cover touch and mouse alike. A `click`
// event still fires right after the pointerup that ends a long press
// (browser default), which would otherwise also trigger the card's own tap
// -> navigate handler — `consume()` reports whether the just-finished press
// was a long press so the caller can swallow that one click.
export function useLongPress(onLongPress: () => void, delayMs = 500): {
  handlers: LongPressHandlers;
  consume: () => boolean;
} {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);

  function start() {
    fired.current = false;
    timer.current = setTimeout(() => {
      fired.current = true;
      onLongPress();
    }, delayMs);
  }

  function clearTimer() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }

  function consume(): boolean {
    const was = fired.current;
    fired.current = false;
    return was;
  }

  return {
    handlers: {
      onPointerDown: start,
      onPointerUp: clearTimer,
      onPointerLeave: clearTimer,
      onPointerCancel: clearTimer,
    },
    consume,
  };
}
