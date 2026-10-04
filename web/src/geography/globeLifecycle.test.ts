import { expect, it, vi } from "vitest";
import { createFrameScheduler } from "./globeLifecycle";

it("deduplicates frames, caps animation at 30fps and stops at idle/hidden/disposal", () => {
  let id = 0,
    draws = 0,
    moving = false;
  const pending = new Map<number, FrameRequestCallback>();
  const scheduler = createFrameScheduler(
    () => {
      draws++;
      return moving;
    },
    {
      request: (fn) => {
        pending.set(++id, fn);
        return id;
      },
      cancel: (id) => {
        pending.delete(id);
      },
    },
  );
  function frame(time: number) {
    const callbacks = [...pending.values()];
    pending.clear();
    callbacks.forEach((fn) => fn(time));
  }
  for (let i = 0; i < 20; i++) scheduler.request();
  expect(pending.size).toBe(1);
  frame(0);
  expect(draws).toBe(1);
  expect(pending.size).toBe(0);
  moving = true;
  scheduler.request();
  frame(10);
  expect(draws).toBe(1);
  frame(34);
  expect(draws).toBe(2);
  expect(pending.size).toBe(1);
  scheduler.setActive(false);
  expect(pending.size).toBe(0);
  scheduler.request();
  expect(pending.size).toBe(0);
  scheduler.setActive(true);
  scheduler.request();
  moving = false;
  frame(68);
  expect(pending.size).toBe(0);
  scheduler.request();
  scheduler.dispose();
  scheduler.dispose();
  expect(pending.size).toBe(0);
  scheduler.request();
  expect(pending.size).toBe(0);
});

it("calls browser frame functions with their native receiver", () => {
  vi.stubGlobal("requestAnimationFrame", function (this: unknown, _callback: FrameRequestCallback) {
    if (this !== undefined && this !== window) throw new TypeError("Illegal invocation");
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", function (this: unknown, _id: number) {
    if (this !== undefined && this !== window) throw new TypeError("Illegal invocation");
  });
  try {
    const scheduler = createFrameScheduler(() => false);
    expect(() => scheduler.request()).not.toThrow();
    expect(() => scheduler.dispose()).not.toThrow();
  } finally {
    vi.unstubAllGlobals();
  }
});
