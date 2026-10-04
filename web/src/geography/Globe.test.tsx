import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { overview } from "./testFixtures";
import { buildMapModel } from "./mapModel";

vi.mock("./globeScene", () => ({
  createGlobeScene: () => {
    throw new Error("WebGL2 unavailable");
  },
}));
import Globe from "./Globe";

it("reports failed context creation once without an automatic retry loop", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container),
    unavailable = vi.fn();
  const model = buildMapModel(overview(), { country: null, location: null });
  try {
    act(() =>
      root.render(
        <Globe model={model} expanded={false} onSelect={() => {}} onUnavailable={unavailable} />,
      ),
    );
    expect(unavailable).toHaveBeenCalledTimes(1);
    act(() =>
      root.render(<Globe model={model} expanded onSelect={() => {}} onUnavailable={unavailable} />),
    );
    expect(unavailable).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
