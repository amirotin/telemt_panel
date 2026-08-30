import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it } from "vitest";
import { DcNode } from "./DcWidget";
import { validateDetailSearch } from "../details-builder/state";
import type { DcStatus } from "../../realtime/topics";
import { ru } from "../../i18n";

function dc(overrides: Partial<DcStatus> = {}): DcStatus {
  return {
    dc: 4,
    endpoints: [],
    endpoint_writers: [],
    available_endpoints: 1,
    available_pct: 100,
    required_writers: 3,
    floor_min: 1,
    floor_target: 3,
    floor_max: 4,
    floor_capped: false,
    alive_writers: 3,
    coverage_pct: 100,
    fresh_alive_writers: 3,
    fresh_coverage_pct: 100,
    rtt_ms: 32.6,
    load: 0,
    ...overrides,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

// The node is a <Link> into the DC diagnostics page, so it needs a router
// that actually owns that route — the same memory-router harness the
// Details builder's own tests use.
async function mount(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const rootRoute = createRootRoute();
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <>{node}</>,
  });
  const diag = createRoute({
    getParentRoute: () => rootRoute,
    path: "/pulse/diag/$domain",
    validateSearch: validateDetailSearch,
    component: () => <p>diag</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([home, diag]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await act(async () => {
    root!.render(<RouterProvider router={router as never} />);
    await router.load();
  });
  return container!;
}

function ring(el: HTMLElement): SVGCircleElement {
  return el.querySelector<SVGCircleElement>('[data-testid="dc-ring"]')!;
}

/** The fraction of the circle the arc actually covers, from its dash array. */
function arcFraction(el: HTMLElement): number {
  const [drawn, total] = ring(el)
    .getAttribute("stroke-dasharray")!
    .split(" ")
    .map((n) => Number(n));
  return Number((drawn! / total!).toFixed(6));
}

describe("DcNode — the coverage ring (concept §9)", () => {
  it("draws a full circle at 100% coverage", async () => {
    const el = await mount(<DcNode dc={dc({ coverage_pct: 100 })} />);
    expect(arcFraction(el)).toBe(1);
  });

  it("draws three quarters at 75%", async () => {
    const el = await mount(<DcNode dc={dc({ coverage_pct: 75, alive_writers: 2 })} />);
    expect(arcFraction(el)).toBe(0.75);
  });

  it("draws nothing at zero coverage", async () => {
    const el = await mount(<DcNode dc={dc({ coverage_pct: 0, alive_writers: 0 })} />);
    expect(arcFraction(el)).toBe(0);
  });

  it("never overdraws the circle when coverage exceeds the floor", async () => {
    const el = await mount(<DcNode dc={dc({ coverage_pct: 133, alive_writers: 4 })} />);
    expect(arcFraction(el)).toBe(1);
  });

  it("colours the ring by state, not the card", async () => {
    const ok = await mount(<DcNode dc={dc({ dc: 4 })} />);
    expect(ring(ok).getAttribute("class")).toContain("text-ok");
    // The tile itself stays dark whatever the state — concept §9: "не
    // делать весь healthy DC зелёным".
    expect(ok.querySelector('[data-testid="dc-node"]')!.className).toContain("bg-surface-2");
  });

  it("mutes a healthy test site's ring and keeps a broken one loud", async () => {
    const quiet = await mount(<DcNode dc={dc({ dc: -4 })} />);
    expect(ring(quiet).getAttribute("class")).toContain("text-text-faint");
    act(() => root!.unmount());
    container!.remove();
    root = null;

    const loud = await mount(<DcNode dc={dc({ dc: -4, alive_writers: 0, coverage_pct: 0 })} />);
    expect(ring(loud).getAttribute("class")).toContain("text-error");
  });
});

describe("DcNode — writers and RTT", () => {
  it("draws one dot per required writer beside the fraction", async () => {
    const el = await mount(<DcNode dc={dc({ required_writers: 3, alive_writers: 2, coverage_pct: 67 })} />);
    const dots = el.querySelector('[data-testid="dc-dots"]')!;
    expect(dots.children).toHaveLength(3);
    expect(el.textContent).toContain("2/3");
  });

  it("omits the dots when the floor is too high to count", async () => {
    const el = await mount(<DcNode dc={dc({ required_writers: 10, alive_writers: 10 })} />);
    expect(el.querySelector('[data-testid="dc-dots"]')).toBeNull();
    expect(el.textContent).toContain("10/10");
  });

  it("keeps a normal RTT neutral and turns a slow one amber", async () => {
    const fast = await mount(<DcNode dc={dc({ rtt_ms: 32.6 })} />);
    const fastRtt = fast.querySelector('[data-testid="dc-rtt"]')!;
    expect(fastRtt.textContent).toBe(`33 ${ru.pulse.dc.rttUnit}`);
    expect(fastRtt.className).toContain("text-text-faint");
    act(() => root!.unmount());
    container!.remove();
    root = null;

    const slow = await mount(<DcNode dc={dc({ rtt_ms: 187.5 })} />);
    const slowRtt = slow.querySelector('[data-testid="dc-rtt"]')!;
    expect(slowRtt.textContent).toBe(`188 ${ru.pulse.dc.rttUnit}`);
    expect(slowRtt.className).toContain("text-warn");
  });
});

describe("DcNode — the link and the label", () => {
  it("opens the DC diagnostics page on the data center it draws", async () => {
    const el = await mount(<DcNode dc={dc({ dc: -203 })} />);
    const link = el.querySelector<HTMLAnchorElement>('[data-testid="dc-node"]')!;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/pulse/diag/dc?entity=dc-203");
  });

  it("names all four facts in one accessible label", async () => {
    const el = await mount(
      <DcNode dc={dc({ dc: 4, coverage_pct: 67, alive_writers: 2, required_writers: 3, rtt_ms: 33 })} />,
    );
    const label = el.querySelector('[data-testid="dc-node"]')!.getAttribute("aria-label")!;
    expect(label).toContain("DC 4");
    expect(label).toContain("67");
    expect(label).toContain("2");
    expect(label).toContain("3");
    expect(label).toContain(`33 ${ru.pulse.dc.rttUnit}`);
  });
});
