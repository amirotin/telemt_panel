import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toggle } from "./Toggle";

// The switch has no visible label of its own, so its accessible name is
// load-bearing: without it a screen reader announces a bare "switch, on".
// ToggleProps requires `aria-label` at the type level; these lock in that
// the component actually forwards it, and the rest of the switch contract.

let mounted: { container: HTMLElement; root: Root } | null = null;

function renderInto(node: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted = { container, root };
  return container.querySelector("button")!;
}

afterEach(() => {
  if (mounted) {
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
});

describe("Toggle", () => {
  it("exposes a switch role with an accessible name and state", () => {
    const el = renderInto(<Toggle checked onChange={() => {}} aria-label="Автообновление" />);
    expect(el.getAttribute("role")).toBe("switch");
    expect(el.getAttribute("aria-checked")).toBe("true");
    expect(el.getAttribute("aria-label")).toBe("Автообновление");
  });

  it("reports the unchecked state", () => {
    const el = renderInto(<Toggle checked={false} onChange={() => {}} aria-label="Только чтение" />);
    expect(el.getAttribute("aria-checked")).toBe("false");
  });

  it("asks for the opposite value on click", () => {
    const onChange = vi.fn();
    const el = renderInto(<Toggle checked={false} onChange={onChange} aria-label="Тема" />);
    act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("does not fire while disabled", () => {
    const onChange = vi.fn();
    const el = renderInto(<Toggle checked onChange={onChange} disabled aria-label="Passkey" />);
    expect(el.disabled).toBe(true);
    act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("is a submit-safe button type", () => {
    // Toggles live inside the Конфигурация form; a default type="submit"
    // would save the whole config on every flip.
    const el = renderInto(<Toggle checked onChange={() => {}} aria-label="Флаг" />);
    expect(el.type).toBe("button");
  });
});
