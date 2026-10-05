import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { runtimeSnapshot, upstreamsSnapshot } from "../__fixtures__/topics";
import { DcPage } from "./DcPage";

vi.mock("../../realtime", () => ({
  useSnapshot: (topic: string) => ({
    data: topic === "runtime" ? runtimeSnapshot : upstreamsSnapshot,
    ts: 1756000000,
    stale: false,
    error: null,
  }),
}));
vi.mock("../../people/useNow", () => ({ useNow: () => 1756000000000 }));
vi.mock("@tanstack/react-router", async () => ({
  ...await vi.importActual("@tanstack/react-router"),
  useNavigate: () => vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("uses current motion preference for DC selection and auto for initial positioning", () => {
  let reduced = true;
  vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(2000);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390);
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
  const scrollTo = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scrollTo });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    act(() => root.render(<DcPage />));
    expect(scrollTo.mock.lastCall?.[0]).toMatchObject({ behavior: "auto" });
    const buttons = host.querySelectorAll<HTMLButtonElement>("[data-dc-pair]");
    expect(buttons.length).toBeGreaterThan(2);
    act(() => buttons[buttons.length - 1]!.click());
    expect(scrollTo.mock.lastCall?.[0]).toMatchObject({ behavior: "auto" });
    reduced = false;
    act(() => buttons[0]!.click());
    expect(scrollTo.mock.lastCall?.[0]).toMatchObject({ behavior: "smooth" });
    reduced = true;
    act(() => buttons[buttons.length - 1]!.click());
    expect(scrollTo.mock.lastCall?.[0]).toMatchObject({ behavior: "auto" });
  } finally {
    act(() => root.unmount());
    host.remove();
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    if (original) Object.defineProperty(HTMLElement.prototype, "scrollTo", original);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  }
});
