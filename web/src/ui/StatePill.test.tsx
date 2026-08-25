import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { StatePill } from "./StatePill";

// DOM-rendering sample test (jsdom environment, vite.config.ts's test
// block) — no extra testing-library dependency: react-dom/client + act is
// enough to prove a primitive actually renders its state and content.
describe("StatePill", () => {
  it("renders its status dot and label text", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<StatePill state="ok">Работает</StatePill>);
    });

    expect(container.textContent).toBe("Работает");
    expect(container.querySelector(".bg-ok")).not.toBeNull();

    act(() => root.unmount());
    container.remove();
  });
});
