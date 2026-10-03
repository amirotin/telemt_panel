import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
