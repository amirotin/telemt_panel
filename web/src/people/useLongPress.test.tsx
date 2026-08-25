import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exceedsMoveThreshold, useLongPress, type LongPressHandlers } from "./useLongPress";

describe("exceedsMoveThreshold (pure)", () => {
  it("is false at the origin", () => {
    expect(exceedsMoveThreshold(0, 0)).toBe(false);
  });
  it("is false just under the default 10px threshold", () => {
    expect(exceedsMoveThreshold(6, 6)).toBe(false); // hypot(6,6) ≈ 8.49
  });
  it("is true just over the default 10px threshold", () => {
    expect(exceedsMoveThreshold(8, 8)).toBe(true); // hypot(8,8) ≈ 11.3
  });
  it("is true for a large horizontal-only move", () => {
    expect(exceedsMoveThreshold(50, 0)).toBe(true);
  });
  it("honors a custom threshold", () => {
    expect(exceedsMoveThreshold(15, 0, 20)).toBe(false);
    expect(exceedsMoveThreshold(25, 0, 20)).toBe(true);
  });
});

// pointerEvent builds a minimal duck-typed stand-in for React's
// PointerEvent — the hook only reads clientX/clientY, so a real jsdom
// PointerEvent isn't needed to exercise the hook's actual timer/threshold
// logic directly (calling the handlers the hook returns, rather than
// dispatching real DOM events through a rendered element).
function pointerEvent(clientX: number, clientY: number) {
  return { clientX, clientY } as Parameters<LongPressHandlers["onPointerDown"]>[0];
}

describe("useLongPress (hook)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let captured: { handlers: LongPressHandlers; consume: () => boolean } | null;
  let onLongPress: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    onLongPress = vi.fn<() => void>();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    captured = null;

    function Harness() {
      captured = useLongPress(onLongPress, 500);
      return null;
    }

    act(() => {
      root.render(<Harness />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("fires onLongPress after the delay when the pointer stays still", () => {
    act(() => captured!.handlers.onPointerDown(pointerEvent(100, 100)));
    act(() => vi.advanceTimersByTime(500));
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(captured!.consume()).toBe(true);
  });

  it("does not fire when a move stays within the threshold", () => {
    act(() => captured!.handlers.onPointerDown(pointerEvent(100, 100)));
    act(() => captured!.handlers.onPointerMove(pointerEvent(104, 104)));
    act(() => vi.advanceTimersByTime(500));
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("cancels when a move exceeds the threshold (scroll gesture)", () => {
    act(() => captured!.handlers.onPointerDown(pointerEvent(100, 100)));
    act(() => captured!.handlers.onPointerMove(pointerEvent(150, 100)));
    act(() => vi.advanceTimersByTime(500));
    expect(onLongPress).not.toHaveBeenCalled();
    expect(captured!.consume()).toBe(false);
  });

  it("cancels on pointerup before the delay elapses", () => {
    act(() => captured!.handlers.onPointerDown(pointerEvent(0, 0)));
    act(() => captured!.handlers.onPointerUp());
    act(() => vi.advanceTimersByTime(500));
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("cancels on pointerleave", () => {
    act(() => captured!.handlers.onPointerDown(pointerEvent(0, 0)));
    act(() => captured!.handlers.onPointerLeave());
    act(() => vi.advanceTimersByTime(500));
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("cancels on pointercancel", () => {
    act(() => captured!.handlers.onPointerDown(pointerEvent(0, 0)));
    act(() => captured!.handlers.onPointerCancel());
    act(() => vi.advanceTimersByTime(500));
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("cancels on touchmove", () => {
    act(() => captured!.handlers.onPointerDown(pointerEvent(0, 0)));
    act(() => captured!.handlers.onTouchMove());
    act(() => vi.advanceTimersByTime(500));
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("cancels on a page scroll happening anywhere (capture-phase window listener)", () => {
    act(() => captured!.handlers.onPointerDown(pointerEvent(0, 0)));
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    act(() => vi.advanceTimersByTime(500));
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("consume() reports false, and stays false, when no long press completed", () => {
    expect(captured!.consume()).toBe(false);
  });

  it("consume() resets after being read once", () => {
    act(() => captured!.handlers.onPointerDown(pointerEvent(0, 0)));
    act(() => vi.advanceTimersByTime(500));
    expect(captured!.consume()).toBe(true);
    expect(captured!.consume()).toBe(false);
  });
});
