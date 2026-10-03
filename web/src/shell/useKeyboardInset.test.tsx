import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardInset } from "./useKeyboardInset";

function InsetProbe() {
  return <output>{useKeyboardInset()}</output>;
}

describe("useKeyboardInset", () => {
  let container: HTMLDivElement;
  let focusHost: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let viewport: EventTarget & { height: number; offsetTop: number };

  beforeEach(() => {
    container = document.createElement("div");
    focusHost = document.createElement("div");
    document.body.append(container, focusHost);
    root = createRoot(container);
    viewport = Object.assign(new EventTarget(), { height: 600, offsetTop: 0 });
    vi.stubGlobal("visualViewport", viewport);
    vi.stubGlobal("innerHeight", 800);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    focusHost.remove();
    vi.unstubAllGlobals();
  });

  function render() {
    act(() => root.render(<InsetProbe />));
  }

  function input(type = "text") {
    const element = document.createElement("input");
    element.type = type;
    focusHost.append(element);
    element.focus();
    return element;
  }

  it("does not treat a viewport shrink as a keyboard while nothing editable is focused", () => {
    render();
    expect(container.textContent).toBe("0");
    act(() => {
      viewport.height = 450;
      viewport.offsetTop = 20;
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(container.textContent).toBe("0");
  });

  it.each(["checkbox", "radio", "range", "button", "file"])("does not raise navigation for a focused %s input", (type) => {
    input(type);
    render();
    expect(container.textContent).toBe("0");
  });

  it("does not raise navigation for a readonly text input", () => {
    input().readOnly = true;
    render();
    expect(container.textContent).toBe("0");
  });

  it("keeps the keyboard offset for an editable input, including visual viewport panning", () => {
    input();
    viewport.offsetTop = 30;
    render();
    expect(container.textContent).toBe("170");
    act(() => {
      viewport.height = 500;
      viewport.offsetTop = 40;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(container.textContent).toBe("260");
  });

  it("keeps the keyboard offset for textarea and contenteditable fields", () => {
    const textarea = document.createElement("textarea");
    focusHost.append(textarea);
    textarea.focus();
    render();
    expect(container.textContent).toBe("200");
    const editor = document.createElement("div");
    editor.tabIndex = 0;
    editor.contentEditable = "true";
    Object.defineProperty(editor, "isContentEditable", { value: true });
    focusHost.append(editor);
    act(() => editor.focus());
    expect(container.textContent).toBe("200");
  });

  it("clears a stale keyboard offset on blur even without a viewport event", () => {
    const field = input();
    render();
    expect(container.textContent).toBe("200");
    act(() => field.blur());
    expect(container.textContent).toBe("0");
  });

  it("remeasures when a keyboard field receives focus", () => {
    viewport.height = 800;
    render();
    expect(container.textContent).toBe("0");
    viewport.height = 500;
    act(() => input());
    expect(container.textContent).toBe("300");
  });

  it.each(["resize", "orientationchange", "pageshow"])("recovers stale viewport geometry after %s", (event) => {
    input();
    render();
    expect(container.textContent).toBe("200");
    viewport.height = 800;
    act(() => window.dispatchEvent(new Event(event)));
    expect(container.textContent).toBe("0");
  });

  it("recovers stale viewport geometry when the installed app returns to the foreground", () => {
    input();
    render();
    expect(container.textContent).toBe("200");
    viewport.height = 800;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(container.textContent).toBe("0");
  });

  it("uses no keyboard offset when the visual viewport API is unavailable", () => {
    vi.stubGlobal("visualViewport", undefined);
    input();
    render();
    expect(container.textContent).toBe("0");
  });
});
