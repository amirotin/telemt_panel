import { useSyncExternalStore } from "react";
import type { SheetPlacement } from "../../../ui/Sheet";
import { LAYOUT_TOKENS } from "./layoutTokens";

/** Spec §15.1's four layout modes. */
export type LayoutMode = "compact-portrait" | "compact-landscape" | "medium" | "wide";

// layoutModeFor is the §15.1 table, in order. Height is evaluated FIRST and
// independently of width: a 844×390 phone in landscape is compact even
// though its width would pass for a tablet, which is the entire point of
// the table ("Ориентация сама по себе не означает desktop"). Wide needs
// BOTH dimensions — a tall narrow window is not a desktop either.
export function layoutModeFor(width: number, height: number): LayoutMode {
  if (height <= LAYOUT_TOKENS.compactHeight) return "compact-landscape";
  if (width < LAYOUT_TOKENS.compactWidth) return "compact-portrait";
  if (width >= LAYOUT_TOKENS.wideWidth && height >= LAYOUT_TOKENS.wideHeight) return "wide";
  return "medium";
}

/** True for the two modes a phone is actually in (§15.2, §15.3). */
export function isCompact(mode: LayoutMode): boolean {
  return mode === "compact-portrait" || mode === "compact-landscape";
}

/**
 * True where the page splits into master + detail: the compact-landscape
 * rail (§15.3, ruling R1) and the wide master pane (§15.4). Portrait and
 * medium keep the single column with a horizontal selector above it.
 */
export function isSplitLayout(mode: LayoutMode): boolean {
  return mode === "compact-landscape" || mode === "wide";
}

// placementFor is §17's table: desktop gets a centered modal, phone
// portrait a bottom sheet, phone landscape a side sheet (a bottom sheet in
// landscape would leave a few rows of usable height).
export function placementFor(layout: LayoutMode): SheetPlacement {
  switch (layout) {
    case "compact-portrait":
      return "bottom";
    case "compact-landscape":
      return "side";
    case "medium":
    case "wide":
      return "modal";
  }
}

// The store half of useLayoutMode. `resize` covers everything — a rotation
// changes innerWidth/innerHeight and fires it — but `orientationchange` is
// kept because some mobile browsers fire it first, and re-reading the same
// two numbers twice costs nothing (the snapshot is a string, so an
// unchanged mode does not re-render).
function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener("resize", onStoreChange);
  window.addEventListener("orientationchange", onStoreChange);
  return () => {
    window.removeEventListener("resize", onStoreChange);
    window.removeEventListener("orientationchange", onStoreChange);
  };
}

function getSnapshot(): LayoutMode {
  return layoutModeFor(window.innerWidth, window.innerHeight);
}

// Mobile-first: with no window to measure (SSR, a non-DOM test runner) the
// page renders the single-column portrait layout, which is legible at every
// size — the opposite default would ship a master/detail split to a phone
// for one frame.
function getServerSnapshot(): LayoutMode {
  return "compact-portrait";
}

// useLayoutMode is the ONE place the builder reads a viewport size. Every
// consumer (AdaptiveDetailSurface picking a sheet placement, DetailPage
// choosing between the stacked column, the landscape rail and the wide
// master/detail split) takes the mode from here, so the §15.1 thresholds
// are decided once.
//
// useSyncExternalStore rather than useState + useEffect: the mode is
// external, mutable, browser state, and the store form gives the correct
// first render (no "portrait for one frame, then wide") plus a documented
// SSR path for free. The snapshot is a string primitive, so returning a
// freshly computed value cannot loop.
export function useLayoutMode(): LayoutMode {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
