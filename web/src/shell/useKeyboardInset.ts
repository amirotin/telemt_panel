import { useEffect, useState } from "react";

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
      const offset = window.innerHeight - vv.height - vv.offsetTop;
      setInset(Math.max(0, Math.round(offset)));
    }

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  return inset;
}
