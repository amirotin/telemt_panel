import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

// Roving tabindex — spec §21's "tabs используют tablist/tab/tabpanel
// keyboard model" and "entity rows доступны клавиатурой".
//
// A list of fifty ranked records made of fifty focusable buttons is
// keyboard-REACHABLE but not keyboard-usable: it puts fifty stops between
// the search box and the "показать ещё" button. The roving pattern gives
// the whole group ONE tab stop and moves the focus inside it with the arrow
// keys, which is also what the ARIA tabs pattern requires.

export type RovingOrientation = "horizontal" | "vertical";

/**
 * Where a key press moves the focus, or `null` when the key is not ours.
 * Wraps at both ends: the entity strip is a ring, and a reader arrowing
 * past the last DC expects the first one, not a dead key.
 */
export function nextRovingIndex(
  key: string,
  current: number,
  count: number,
  orientation: RovingOrientation,
): number | null {
  if (count <= 0) return null;
  const forward = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
  const backward = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
  switch (key) {
    case forward:
      return (current + 1 + count) % count;
    case backward:
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Marks an element as a member of its container's roving group. */
export const ROVING_ITEM_ATTR = "data-roving-item";

export interface RovingFocusApi {
  /** Spread onto the group's container element. */
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  /** `0` for the single tab stop, `-1` for every other member. */
  tabIndexFor: (index: number) => 0 | -1;
  /** Spread onto each member — the tab stop plus the marker attribute. */
  itemProps: (index: number) => { tabIndex: 0 | -1; [ROVING_ITEM_ATTR]: string };
}

export interface UseRovingFocusOptions {
  count: number;
  orientation: RovingOrientation;
  /** Index of the ACTIVE member (selected tab, current entity) — the tab stop's home. */
  activeIndex?: number;
}

// useRovingFocus keeps the tab stop on the active member until the reader
// arrows away, then follows the focus.
//
// It holds NO ref: the container is `event.currentTarget` — the element the
// handler is attached to — and the members are found under it by the marker
// attribute. That is not a shortcut but the correct data flow here: the
// groups this serves are rendered by `.map()` over data that a realtime
// frame replaces wholesale, so an array of refs indexed by position would
// go stale exactly when §19.1 says nothing may move.
export function useRovingFocus({
  count,
  orientation,
  activeIndex = 0,
}: UseRovingFocusOptions): RovingFocusApi {
  const [focusIndex, setFocusIndex] = useState(activeIndex);
  // The tab stop follows the active member: picking DC 5 with the mouse
  // and then pressing Tab must land on DC 5, not on wherever the arrows
  // were last. React's "adjust state during render" pattern, as in
  // state.ts's page-id reset.
  const [lastActive, setLastActive] = useState(activeIndex);
  if (lastActive !== activeIndex) {
    setLastActive(activeIndex);
    setFocusIndex(activeIndex);
  }

  const clamped = count === 0 ? 0 : Math.min(Math.max(focusIndex, 0), count - 1);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const next = nextRovingIndex(event.key, clamped, count, orientation);
    if (next === null) return;
    event.preventDefault();
    setFocusIndex(next);
    const items = event.currentTarget.querySelectorAll<HTMLElement>(`[${ROVING_ITEM_ATTR}]`);
    items[next]?.focus();
  };

  const tabIndexFor = (index: number): 0 | -1 => (index === clamped ? 0 : -1);

  return {
    onKeyDown,
    tabIndexFor,
    itemProps: (index) => ({ tabIndex: tabIndexFor(index), [ROVING_ITEM_ATTR]: "" }),
  };
}
