import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { LogList } from "./LogList";
import type { RingLine } from "./logRing";

function makeLine(id: number, msg: string): RingLine {
  return { id, ts: new Date(2026, 0, 1, 0, 0, id).toISOString(), level: "info", msg };
}

// Forces the container's scroll geometry (jsdom performs no real layout —
// scrollTop/clientHeight/scrollHeight are all 0 by default) so LogList's
// own isScrolledToBottom check actually reports "scrolled up", the
// precondition for the floating "к новым" button to render at all.
function markScrolledUp(el: HTMLDivElement) {
  Object.defineProperty(el, "scrollTop", { value: 0, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 100, configurable: true });
  Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true });
}

describe("LogList — floating «к новым» button", () => {
  it("positions itself relative to the lg: content column, not the full viewport", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root;

    act(() => {
      root = createRoot(container);
      root.render(<LogList lines={[makeLine(1, "first")]} showUnit={false} />);
    });

    const scroll = container.querySelector<HTMLDivElement>('[data-testid="log-list-scroll"]')!;
    markScrolledUp(scroll);
    act(() => {
      scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    // A new line arrives while scrolled up — this is what makes the
    // button appear (newSinceScrolledUp > 0).
    act(() => {
      root.render(<LogList lines={[makeLine(1, "first"), makeLine(2, "second")]} showUnit={false} />);
    });

    const button = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("1"),
    );
    expect(button).toBeDefined();
    // Shell.tsx's sidebar is `w-56` at `lg:` — the button must narrow its
    // centering box to `lg:left-56 lg:right-0` (the content column alone)
    // instead of the viewport-wide `inset-x-0` it inherits below `lg:`, or
    // it visibly centers under the sidebar+content combined.
    expect(button!.className).toContain("lg:left-56");
    expect(button!.className).toContain("lg:right-0");

    act(() => root.unmount());
    container.remove();
  });
});
