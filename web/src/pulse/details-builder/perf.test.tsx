// Spec §20 as an executable budget, on the two heaviest production
// payloads this wave has: Security (4×50 TLS records across four rankings,
// plus a 1955-leaf unknown tail) and ME (46 writers, 16 initialization
// components).
//
// «Не создавать DOM для закрытых больших секций» is not a preference that
// can be checked by reading the code — `hidden` looks like hiding and is in
// fact mounting. This file counts the nodes instead, so the day someone
// swaps the opened-latch back for a plain `hidden` the budget fails rather
// than the page silently getting four times heavier.
//
// It also prints a mount time per page (`PERF` lines) — informative, never
// asserted: a wall-clock threshold in CI is a flake generator, and the
// number that matters (the node count) is deterministic.

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DisplayModeProvider } from "../../display-mode";
import { DetailPage } from "./DetailPage";
import { securityPageDefinition } from "./definitions/security";
import { mePageDefinition } from "./definitions/me";
import { securityPageData } from "../diag/security.helpers";
import { mePagePayload } from "../diag/me.helpers";
import { TLS_FINGERPRINTS_ENDPOINT } from "./fieldCatalog";
import {
  effectiveLimits,
  meWriters,
  posture,
  runtimeSnapshot,
  tlsFingerprints,
  whitelist,
} from "./__fixtures__";
import { aggregateSources, type PageSourcesState, type SourceState } from "./sources";
import { validateDetailSearch } from "./state";

const FRESH_AT = 1_756_000_000_000;
const NOW = FRESH_AT + 125_000;

function ready(ids: readonly string[]): PageSourcesState {
  const byId: Record<string, SourceState> = {};
  for (const id of ids) {
    byId[id] = { id, status: "ready", freshnessMs: FRESH_AT, hasData: true };
  }
  return aggregateSources(
    ids.map((id) => ({ id, required: true })),
    byId,
  );
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(node: ReactNode, url: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const rootRoute = createRootRoute();
  const pageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/page",
    validateSearch: validateDetailSearch,
    component: () => <DisplayModeProvider>{node}</DisplayModeProvider>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([pageRoute]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  const started = performance.now();
  await act(async () => {
    root!.render(<RouterProvider router={router as never} />);
    await router.load();
  });
  return { elapsedMs: performance.now() - started, container: container! };
}

function elementCount(el: HTMLElement): number {
  return el.querySelectorAll("*").length;
}

/** Panels of sections that are collapsed right now, by their aria-controls id. */
function collapsedPanels(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll('button[aria-expanded="false"][aria-controls]'))
    .map((b) => el.querySelector<HTMLElement>(`#${CSS.escape(b.getAttribute("aria-controls")!)}`))
    .filter((p): p is HTMLElement => p !== null);
}

beforeEach(() => {
  window.scrollTo = () => {};
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  root = null;
  container = null;
});

describe("spec §20: a closed large section creates no DOM", () => {
  it("mounts none of the four 50-record TLS rankings until they are opened", async () => {
    const payload = securityPageData(
      { posture, whitelist, effective_limits: effectiveLimits },
      tlsFingerprints,
    );
    const { container: el, elapsedMs } = await mount(
      <DetailPage
        definition={securityPageDefinition}
        payload={payload}
        sources={ready(securityPageDefinition.sources.map((s) => s.id))}
        endpoint={TLS_FINGERPRINTS_ENDPOINT}
        nowMs={NOW}
      />,
      "/page?tab=ja3",
    );
    const nodes = elementCount(el);
    console.log(`PERF security 4x50: ${nodes} elements, mount ${elapsedMs.toFixed(1)} ms`);

    // Every closed section's panel is EMPTY — the aria-controls target still
    // exists (§21), it just has nothing in it.
    const closed = collapsedPanels(el);
    expect(closed.length).toBeGreaterThan(0);
    for (const panel of closed) expect(panel.childElementCount).toBe(0);

    // 200 TLS rows × ~6 elements each would be well past this on their own;
    // the budget is deliberately loose enough not to break on a copy change
    // and tight enough that a re-mounted collapsed ranking blows it.
    expect(nodes).toBeLessThan(600);
  });

  it("keeps the rows once a ranking has been opened, and drops none on collapse", async () => {
    const payload = securityPageData(
      { posture, whitelist, effective_limits: effectiveLimits },
      tlsFingerprints,
    );
    const { container: el } = await mount(
      <DetailPage
        definition={securityPageDefinition}
        payload={payload}
        sources={ready(securityPageDefinition.sources.map((s) => s.id))}
        endpoint={TLS_FINGERPRINTS_ENDPOINT}
        nowMs={NOW}
      />,
      "/page?tab=ja3",
    );
    const toggle = el.querySelector<HTMLButtonElement>('button[aria-expanded="false"][aria-controls]')!;
    const panel = el.querySelector<HTMLElement>(`#${CSS.escape(toggle.getAttribute("aria-controls")!)}`)!;

    act(() => toggle.click());
    const opened = panel.childElementCount;
    expect(opened).toBeGreaterThan(0);

    // The latch: collapsing hides the panel but keeps its subtree, so the
    // rows' own state (a «Показать ещё» limit, an open surface) survives a
    // round trip and re-opening costs no second mount.
    act(() => toggle.click());
    expect(panel.hidden).toBe(true);
    expect(panel.childElementCount).toBe(opened);

    // Ruling R8's evidence: with EVERY section on the tab open at once, the
    // page is still a few hundred elements — §10.5's progressive reveal caps
    // each collection long before a virtualizer would earn its focus and
    // screen-reader cost.
    for (const b of Array.from(
      el.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"][aria-controls]'),
    )) {
      act(() => b.click());
    }
    const allOpen = elementCount(el);
    console.log(`PERF security 4x50, every section open: ${allOpen} elements`);
    expect(allOpen).toBeLessThan(1200);
  });

  it("holds the rule in extended mode, where the deep sections appear", async () => {
    // Extended is the mode that reveals the raw/unknown tail and the deep
    // maps (R2). On these fixtures the tail is EMPTY by construction — §27.4
    // says every leaf of the 1955 the TLS payload carries is consumed — so
    // what this pins is that switching modes adds no mounted-but-closed
    // section, not a second copy of the count above.
    localStorage.setItem("telemt-panel:display-mode:v1", "extended");
    try {
      const payload = securityPageData(
        { posture, whitelist, effective_limits: effectiveLimits },
        tlsFingerprints,
      );
      const { container: el, elapsedMs } = await mount(
        <DetailPage
          definition={securityPageDefinition}
          payload={payload}
          sources={ready(securityPageDefinition.sources.map((s) => s.id))}
          endpoint={TLS_FINGERPRINTS_ENDPOINT}
          nowMs={NOW}
        />,
        "/page?tab=ja3",
      );
      const nodes = elementCount(el);
      console.log(`PERF security extended: ${nodes} elements, mount ${elapsedMs.toFixed(1)} ms`);
      for (const panel of collapsedPanels(el)) expect(panel.childElementCount).toBe(0);
      expect(nodes).toBeLessThan(700);
    } finally {
      localStorage.removeItem("telemt-panel:display-mode:v1");
    }
  });

  it("does not mount the 46-writer ME page's closed sections either", async () => {
    const payload = mePagePayload({
      meWriters,
      gates: runtimeSnapshot.gates ?? null,
      initialization: runtimeSnapshot.initialization ?? null,
    });
    const { container: el, elapsedMs } = await mount(
      <DetailPage
        definition={mePageDefinition}
        payload={payload}
        sources={ready(mePageDefinition.sources.map((s) => s.id))}
        nowMs={NOW}
      />,
      "/page",
    );
    const nodes = elementCount(el);
    console.log(`PERF me 46 writers: ${nodes} elements, mount ${elapsedMs.toFixed(1)} ms`);

    for (const panel of collapsedPanels(el)) expect(panel.childElementCount).toBe(0);
    expect(nodes).toBeLessThan(600);
  });
});
