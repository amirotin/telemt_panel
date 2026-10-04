import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HelpHint } from "./HelpHint";

describe("HelpHint interaction", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<><HelpHint label="Limit rejections">Historical events, not live pressure.</HelpHint><input aria-label="Next field"/></>));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  });
  const tip = () => document.querySelector<HTMLElement>('[role="tooltip"]');
  const trigger = () => host.querySelector<HTMLButtonElement>("button")!;

  it("opens on press, links the description, and closes on a second press", () => {
    expect(tip()).toBeNull();
    act(() => trigger().click());
    expect(tip()?.textContent).toBe("Historical events, not live pressure.");
    expect(trigger().getAttribute("aria-describedby")).toBe(tip()?.id);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    act(() => trigger().click());
    expect(tip()).toBeNull();
    expect(trigger().hasAttribute("aria-describedby")).toBe(false);
  });

  it("dismisses on outside press without consuming the next field's interaction", () => {
    act(() => trigger().click());
    const next = host.querySelector("input")!;
    act(() => { next.dispatchEvent(new Event("pointerdown", {bubbles:true})); next.focus(); });
    expect(tip()).toBeNull();
    expect(document.activeElement).toBe(next);
  });

  it("does not dismiss when interacting with the readable help text", () => {
    act(() => trigger().click());
    act(() => trigger().focus());
    act(() => { tip()!.dispatchEvent(new Event("pointerdown", {bubbles:true})); trigger().blur(); });
    expect(tip()).not.toBeNull();
    act(() => document.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",bubbles:true})));
    expect(tip()).toBeNull();
  });

  it("opens for keyboard focus and Escape closes without moving focus", () => {
    act(() => document.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",bubbles:true})));
    act(() => trigger().focus());
    expect(tip()).not.toBeNull();
    act(() => document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
    expect(tip()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    act(() => trigger().click());
    expect(tip()).not.toBeNull();
    act(() => host.querySelector("input")!.focus());
    expect(tip()).toBeNull();
  });

  it("retains event handlers when a parent recreates help markup", () => {
    const windowAdd = vi.spyOn(window, "addEventListener");
    const windowRemove = vi.spyOn(window, "removeEventListener");
    const documentAdd = vi.spyOn(document, "addEventListener");
    const documentRemove = vi.spyOn(document, "removeEventListener");
    const render = () => act(() => root.render(<><HelpHint label="Limit rejections"><p>Historical events, not live pressure.</p></HelpHint><input aria-label="Next field"/></>));
    render();
    act(() => trigger().click());
    const windowEvents = ["resize", "scroll"];
    const documentEvents = ["pointerdown", "keydown"];
    const registrations = () => [
      windowAdd.mock.calls.filter(([event]) => windowEvents.includes(event)).length,
      documentAdd.mock.calls.filter(([event]) => documentEvents.includes(event)).length,
    ];
    const initial = registrations();
    render();
    expect(tip()?.textContent).toBe("Historical events, not live pressure.");
    expect(registrations()).toEqual(initial);
    expect(windowRemove.mock.calls.filter(([event]) => windowEvents.includes(event))).toEqual([]);
    expect(documentRemove.mock.calls.filter(([event]) => documentEvents.includes(event))).toEqual([]);
    act(() => document.dispatchEvent(new Event("pointerdown", {bubbles:true})));
    expect(tip()).toBeNull();
  });

  it("repositions when the open help text changes size and disconnects on dismissal", () => {
    let resize: ResizeObserverCallback | undefined;
    let observed: Element | undefined;
    let disconnected = false;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe(element: Element) { observed = element; }
      disconnect() { disconnected = true; }
    });
    let height = 50;
    const rect = (left: number, top: number, width: number, boxHeight: number) => ({left, top, right:left+width, bottom:top+boxHeight, width, height:boxHeight, x:left, y:top, toJSON:()=>({})});
    vi.spyOn(trigger(), "getBoundingClientRect").mockImplementation(() => rect(900, 720, 40, 20));
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "tooltip" ? rect(0, 0, 340, height) : originalRect.call(this);
    });
    act(() => trigger().click());
    expect(tip()?.style.top).toBe("662px");
    expect(observed).toBe(tip());
    act(() => root.render(<><HelpHint label="Limit rejections"><p>Longer explanation of historical limit rejections.</p></HelpHint><input aria-label="Next field"/></>));
    height = 150;
    act(() => resize?.([], {} as ResizeObserver));
    expect(tip()?.style.top).toBe("562px");
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true})));
    expect(tip()).toBeNull();
    expect(disconnected).toBe(true);
  });
});
