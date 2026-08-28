import { useEffect, useState } from "react";
import type { SheetPlacement } from "../../../ui/Sheet";

/** Spec §15.1's four layout modes. */
export type LayoutMode = "compact-portrait" | "compact-landscape" | "medium" | "wide";

// Thresholds from §15.1. Height is evaluated FIRST and independently of
// width: a 844×390 phone in landscape is compact even though its width
// would pass for a tablet, which is the entire point of the table
// ("Ориентация сама по себе не означает desktop").
const COMPACT_HEIGHT = 520;
const COMPACT_WIDTH = 600;
const WIDE_WIDTH = 900;
const WIDE_HEIGHT = 600;

export function layoutModeFor(width: number, height: number): LayoutMode {
  if (height <= COMPACT_HEIGHT) return "compact-landscape";
  if (width < COMPACT_WIDTH) return "compact-portrait";
  if (width >= WIDE_WIDTH && height >= WIDE_HEIGHT) return "wide";
  return "medium";
}

// useLayoutModeStub is the MINIMAL layout-mode hook Task 3 needs, and it is
// deliberately temporary: Task 5 replaces it with the real `useLayoutMode()`
// (breakpoints as design tokens, compact-landscape styling, the wide
// master/detail split, orientation-change state preservation).
//
// It exists so that exactly ONE import site in this task depends on the
// layout mode — surfaces/AdaptiveDetailSurface, which has to choose between
// a bottom sheet, a side sheet and a modal (§17). When Task 5 lands, delete
// this file and point that one import at the real hook; nothing else in the
// builder reads a viewport size.
export function useLayoutModeStub(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(() =>
    layoutModeFor(window.innerWidth, window.innerHeight),
  );

  useEffect(() => {
    const update = () => setMode(layoutModeFor(window.innerWidth, window.innerHeight));
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  return mode;
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
