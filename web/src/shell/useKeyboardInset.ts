import { useEffect, useState } from "react";

const NON_KEYBOARD_INPUT_TYPES = new Set([
  "button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit",
]);

function hasKeyboardFocus(): boolean {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement) {
    return !active.readOnly && !active.disabled && active.inputMode !== "none" && !NON_KEYBOARD_INPUT_TYPES.has(active.type);
  }
  if (active instanceof HTMLTextAreaElement) return !active.readOnly && !active.disabled;
  return active instanceof HTMLElement && active.isContentEditable;
}

// useKeyboardInset tracks how far the on-screen keyboard currently pushes
// the visual viewport up from the layout viewport's bottom edge. The
// bottom tab bar (position: fixed) subtracts this so it sits above the
// keyboard instead of floating over whatever input triggered it
// (design-brief.md "Диалоги на мобайле — ... работают с открытой
// клавиатурой"; M3 plan Task 4: "tab bar must not float over inputs").
// Guarded for environments without `visualViewport` (jsdom, older browsers)
// — inset simply stays 0 there.
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    function update() {
      if (!vv) return;
      // Standalone Safari can resize or pan its visual viewport while
      // scrolling. Without an editable focus this is not a keyboard offset.
      if (!hasKeyboardFocus()) {
        setInset(0);
        return;
      }
      const offset = window.innerHeight - vv.height - vv.offsetTop;
      setInset(Math.max(0, Math.round(offset)));
    }

    const clear = () => setInset(0);
    const windowEvents = ["resize", "orientationchange", "pageshow"];
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", clear);
    document.addEventListener("visibilitychange", update);
    windowEvents.forEach((event) => window.addEventListener(event, update));
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", clear);
      document.removeEventListener("visibilitychange", update);
      windowEvents.forEach((event) => window.removeEventListener(event, update));
    };
  }, []);

  return inset;
}
