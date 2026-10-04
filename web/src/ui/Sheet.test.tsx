import { act, createRef, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Sheet } from "./Sheet";

describe("Sheet focus lifecycle", () => {
  it("allows label-forwarded control clicks within one pointer interaction",async()=>{
    const container=document.createElement("div");document.body.append(container);const root=createRoot(container),control=vi.fn(),foreign=vi.fn();
    try{act(()=>root.render(<Sheet open onClose={()=>{}} title="Form"><label><span data-label>Mode</span><input type="radio" onClick={control}/></label><button data-foreign onClick={foreign}>Other</button></Sheet>));
      const label=document.querySelector("[data-label]")!;
      await act(async()=>{label.dispatchEvent(new MouseEvent("pointerdown",{bubbles:true}));label.dispatchEvent(new MouseEvent("click",{bubbles:true,detail:1}));});
      expect(control).toHaveBeenCalledTimes(1);
      act(()=>document.querySelector("[data-foreign]")!.dispatchEvent(new MouseEvent("click",{bubbles:true,detail:1})));
      expect(foreign).not.toHaveBeenCalled();
    }finally{act(()=>root.unmount());container.remove()}
  });
  it("focuses the requested field once and restores the opener after close", () => {
    const container = document.createElement("div");
    const opener = document.createElement("button");
    document.body.append(opener, container);
    opener.focus();
    const root = createRoot(container);
    const input = createRef<HTMLInputElement>();
    const firstClose = vi.fn(),
      currentClose = vi.fn();
    const overflow = document.body.style.overflow;
    const render = (open: boolean, value: string, onClose: () => void) =>
      act(() =>
        root.render(
          <StrictMode>
            <Sheet open={open} onClose={onClose} title="Form" initialFocusRef={input}>
              <input ref={input} value={value} onChange={() => {}} />
              <button data-submit>Submit</button>
            </Sheet>
          </StrictMode>,
        ),
      );
    try {
      render(true, "first", firstClose);
      expect(document.activeElement).toBe(input.current);
      expect(document.body.style.overflow).toBe("hidden");
      const submit = document.querySelector<HTMLButtonElement>("[data-submit]")!;
      submit.focus();
      render(true, "edited", currentClose);
      expect(document.activeElement).toBe(submit);
      expect(input.current?.value).toBe("edited");
      act(() =>
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      );
      expect(currentClose).toHaveBeenCalledOnce();
      expect(firstClose).not.toHaveBeenCalled();
      render(false, "edited", currentClose);
      expect(document.activeElement).toBe(opener);
      expect(document.body.style.overflow).toBe(overflow);
    } finally {
      act(() => root.unmount());
      opener.remove();
      container.remove();
    }
  });

  it("retains the first-focusable fallback when no preferred element exists", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          <Sheet open onClose={() => {}} title="Plain">
            <button>Action</button>
          </Sheet>,
        ),
      );
      expect(document.activeElement).toBe(document.querySelector('[role="dialog"] button'));
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
