import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Popover } from "./Popover";

// Popover is hand-rolled (no dependency ships one — web/README.md), so the
// behaviour a reader depends on has to be pinned here: the trigger declares
// what it opens, the panel is a named dialog, Escape and an outside click
// dismiss it, focus goes in and comes back.

let mounted: { container: HTMLElement; root: Root } | null = null;

function renderInto(node: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted = { container, root };
  return container;
}

function trigger(container: HTMLElement) {
  return container.querySelector("button")!;
}

function panel() {
  return document.querySelector('[role="dialog"]');
}

afterEach(() => {
  if (mounted) {
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
});

describe("Popover", () => {
  it("declares what the trigger opens and whether it is open", () => {
    const container = renderInto(
      <Popover label="Вид: Стандартный">
        <button type="button">Открыть меню</button>
      </Popover>,
    );
    const btn = trigger(container);
    expect(btn.getAttribute("aria-haspopup")).toBe("dialog");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(panel()).toBeNull();

    act(() => btn.click());
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(panel()?.getAttribute("aria-label")).toBe("Вид: Стандартный");
  });

  it("moves focus into the panel and returns it to the trigger on Escape", () => {
    const container = renderInto(
      <Popover label="Вид">
        <button type="button">Открыть меню</button>
      </Popover>,
    );
    const btn = trigger(container);
    act(() => btn.click());
    expect(document.activeElement?.textContent).toBe("Открыть меню");

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  it("dismisses on an outside click", () => {
    const container = renderInto(
      <Popover label="Вид">
        <button type="button">Открыть меню</button>
      </Popover>,
    );
    act(() => trigger(container).click());
    expect(panel()).not.toBeNull();

    act(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(panel()).toBeNull();
  });

  // Every control in a menu of this shape is a choice; the menu closes once
  // one has been made, after the control's own handler has run.
  it("closes after a button inside it is used, having run its handler", () => {
    const onPick = vi.fn();
    const container = renderInto(
      <Popover label="Вид">
        <button type="button" onClick={onPick}>
          Расширенный
        </button>
      </Popover>,
    );
    act(() => trigger(container).click());
    act(() => {
      document.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click();
    });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(panel()).toBeNull();
  });
});
