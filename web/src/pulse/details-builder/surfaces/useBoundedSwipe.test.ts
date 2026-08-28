import { describe, expect, it } from "vitest";
import {
  SWIPE_EDGE_DEAD_ZONE_PX,
  SWIPE_THRESHOLD_PX,
  abandonsForScroll,
  startsInEdgeDeadZone,
  swipeVerdict,
} from "./useBoundedSwipe";

// The §16.2 constraints as facts. The gesture itself is exercised end to
// end in DetailPage.responsive.test.tsx (pointer stream on the hero); this
// file pins the four numbers and the priority rule they encode, because
// every one of them is a spec value rather than a taste.

describe("swipeVerdict (spec §16.2)", () => {
  it("needs ~56 px of horizontal travel", () => {
    expect(SWIPE_THRESHOLD_PX).toBe(56);
    expect(swipeVerdict(-(SWIPE_THRESHOLD_PX - 1), 0)).toBe("none");
    expect(swipeVerdict(-SWIPE_THRESHOLD_PX, 0)).toBe("next");
    expect(swipeVerdict(SWIPE_THRESHOLD_PX, 0)).toBe("previous");
  });

  it("pulls the NEXT entity in when the finger goes left", () => {
    expect(swipeVerdict(-120, 0)).toBe("next");
    expect(swipeVerdict(120, 0)).toBe("previous");
  });

  it("gives the vertical axis priority however far the finger travelled", () => {
    // "вертикальное движение имеет приоритет над горизонтальным" — a
    // diagonal drag that moved further down the page is a scroll.
    expect(swipeVerdict(-200, 260)).toBe("none");
    expect(swipeVerdict(-200, 199)).toBe("next");
  });
});

describe("the left-edge dead zone (spec §16.2)", () => {
  it("leaves the first 24 px to the system Back gesture", () => {
    expect(SWIPE_EDGE_DEAD_ZONE_PX).toBe(24);
    expect(startsInEdgeDeadZone(0)).toBe(true);
    expect(startsInEdgeDeadZone(SWIPE_EDGE_DEAD_ZONE_PX)).toBe(true);
    expect(startsInEdgeDeadZone(SWIPE_EDGE_DEAD_ZONE_PX + 1)).toBe(false);
  });
});

describe("abandonsForScroll", () => {
  it("drops the gesture as soon as the drag commits to scrolling", () => {
    expect(abandonsForScroll(4, 40)).toBe(true);
    expect(abandonsForScroll(40, 4)).toBe(false);
    // A few pixels of jitter down are not a scroll yet.
    expect(abandonsForScroll(0, 6)).toBe(false);
  });
});
