import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, afterEach } from "vitest";
import { Gated } from "./Gated";

function renderInto(node: React.ReactElement): { container: HTMLElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

let mounted: { container: HTMLElement; root: Root } | null = null;

afterEach(() => {
  if (mounted) {
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
});

describe("Gated", () => {
  it("renders children when enabled", () => {
    mounted = renderInto(
      <Gated enabled reason="unused">
        <span>содержимое</span>
      </Gated>,
    );
    expect(mounted.container.textContent).toBe("содержимое");
  });

  it("renders the disabled block with reason and hint when not enabled", () => {
    mounted = renderInto(
      <Gated enabled={false} reason="minimal gate disabled" hint="runtime_edge">
        <span>содержимое</span>
      </Gated>,
    );
    expect(mounted.container.textContent).not.toContain("содержимое");
    expect(mounted.container.textContent).toContain("Выключено:");
    expect(mounted.container.textContent).toContain("minimal gate disabled");
    expect(mounted.container.textContent).toContain("runtime_edge_enabled");
  });

  it("falls back to the default reason when none is given", () => {
    mounted = renderInto(<Gated enabled={false} />);
    expect(mounted.container.textContent).toContain("функция недоступна на этом сервере.");
  });

});
