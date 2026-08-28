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
import { dcs, meWriters } from "./__fixtures__";
import { DetailPage } from "./DetailPage";
import type { DetailPageDefinition } from "./model";
import { aggregateSources, resolveQuerySource, type PageSourcesState } from "./sources";
import { validateDetailSearch } from "./state";
import type { DcStatus, DcStatusData } from "../../realtime/topics";

// Responsive layout and interaction — spec §15 (modes), §16 (the ONE
// gesture and its mandatory pager), §19.1 (a rotation is not allowed to
// reset anything) and §21 (tabs, roving focus).
//
// The claim these tests exist to prove is §15.3's last line: "поворот не
// сбрасывает выбранную сущность, filters и expanded state". DetailPage
// implements it by construction — one element tree in every mode, the
// interaction state in the URL and in route memory — and a test that
// rotates a page with an accordion open, a query typed and a surface up is
// the only way to keep it that way.

const FRESH_AT = 1_756_000_000_000;
const NOW = FRESH_AT + 125_000;

const dcKey = (dc: DcStatus): string => `dc${dc.dc}`;

const dcPage: DetailPageDefinition<DcStatusData, DcStatus> = {
  id: "test.responsive.dc",
  title: () => "Data Centers",
  description: () => "Выберите DC — справа отображается только его состояние.",
  sources: [{ id: "upstreams", topic: "upstreams", required: true }],
  navigation: {
    entities: {
      path: "dcs",
      entityKey: (item) => dcKey(item as DcStatus),
      label: (item) => `DC ${(item as DcStatus).dc}`,
    },
    selectEntity: (payload, key) =>
      payload.dcs.find((dc) => dcKey(dc) === key) ?? payload.dcs[0] ?? null,
    tabs: [
      { id: "routing", label: () => "Маршрутизация", sections: ["routing"] },
      { id: "endpoints", label: () => "Точки", sections: ["endpoints"] },
    ],
  },
  summary: [{ id: "load", label: () => "Нагрузка", value: (dc) => dc.load, format: "integer" }],
  sections: [
    {
      kind: "scalars",
      id: "routing",
      title: () => "Routing & capacity",
      defaultExpanded: true,
      fields: [{ path: "dc" }, { path: "rtt_ms" }, { path: "load" }],
    },
    {
      kind: "entityList",
      id: "endpoints",
      title: () => "endpoints[]",
      path: "endpoints",
      defaultExpanded: true,
      itemKey: (_item, i) => `ep-${i}`,
      identity: (item) => String(item),
    },
  ],
  unknownFields: { minMode: "extended" },
};

const DC_READY: PageSourcesState = aggregateSources(dcPage.sources, {
  upstreams: resolveQuerySource("upstreams", {
    kind: "query",
    isPending: false,
    isError: false,
    data: dcs,
    dataUpdatedAt: FRESH_AT,
  }),
});

interface Writer {
  writer_id: number;
  dc: number;
  degraded: boolean;
  bound_clients: number;
  rtt_ema_ms: number;
}

// A summary tile that shortcuts to a SORT (§18.2) — the other half of the
// Task 4 review's L4: once the sort control can release its slot, the
// shortcut has to be able to fill it again.
const writersPage: DetailPageDefinition<typeof meWriters, typeof meWriters> = {
  id: "test.responsive.writers",
  title: () => "Writers",
  sources: [{ id: "runtime", topic: "runtime", required: true }],
  summary: [
    {
      id: "slowest",
      label: () => "Самый медленный",
      value: (p) => Math.max(...p.writers.map((w) => w.rtt_ema_ms ?? 0)),
      format: "integer",
      shortcut: { sort: { key: "rtt_ema_ms", direction: "desc", sectionId: "writers" } },
    },
  ],
  sections: [
    {
      kind: "ranking",
      id: "writers",
      title: () => "writers[]",
      path: "writers",
      defaultExpanded: true,
      itemKey: (item) => `writer:${(item as Writer).writer_id}`,
      identity: (item) => `writer #${(item as Writer).writer_id}`,
      score: (item) => (item as Writer).bound_clients,
      scoreKey: "bound_clients",
    },
  ],
  unknownFields: { minMode: "extended" },
};

const WRITERS_READY: PageSourcesState = aggregateSources(writersPage.sources, {
  runtime: resolveQuerySource("runtime", {
    kind: "query",
    isPending: false,
    isError: false,
    data: meWriters,
    dataUpdatedAt: FRESH_AT,
  }),
});

// --- harness -------------------------------------------------------------

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
}

async function rotate(width: number, height: number): Promise<void> {
  await act(async () => {
    setViewport(width, height);
    window.dispatchEvent(new Event("resize"));
  });
}

async function mount(node: ReactNode, url = "/page") {
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
  await act(async () => {
    root!.render(<RouterProvider router={router as never} />);
    await router.load();
  });
  return { router, container: container! };
}

// jsdom ships no PointerEvent constructor, so the pointer stream is a
// MouseEvent carrying the two fields the hook reads. React dispatches by
// event NAME and reads the properties off the native event, so this is the
// same path a real touch takes.
function pointer(
  type: "pointerdown" | "pointermove" | "pointerup",
  x: number,
  y: number,
  pointerType = "touch",
): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  return event;
}

function swipe(el: HTMLElement, fromX: number, toX: number, y = 300): void {
  act(() => {
    el.dispatchEvent(pointer("pointerdown", fromX, y));
    el.dispatchEvent(pointer("pointermove", toX, y));
    el.dispatchEvent(pointer("pointerup", toX, y));
  });
}

// React tracks an input's value and skips onChange when the node's value
// is assigned directly — the native setter is the documented way in.
function type(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(el: Element): void {
  act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function press(el: Element, key: string): void {
  act(() => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
}

function layoutOf(el: HTMLElement): string | null {
  return el.querySelector<HTMLElement>("[data-layout]")?.dataset["layout"] ?? null;
}

function hero(el: HTMLElement): HTMLElement {
  const node = el.querySelector<HTMLElement>('[data-testid="detail-hero"]');
  if (!node) throw new Error("no hero region");
  return node;
}

function selected(el: HTMLElement): string | null {
  const active = el.querySelector<HTMLElement>(
    '[data-testid="entity-selector"] [aria-pressed="true"]',
  );
  return active?.textContent ?? null;
}

beforeEach(() => {
  window.scrollTo = () => {};
  setViewport(360, 640);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  root = null;
  container = null;
  setViewport(1024, 768);
});

// --- §15: the four modes on one page ------------------------------------

describe("DetailPage layout modes (spec §15)", () => {
  it("stacks in portrait and splits into master/detail in landscape and wide", async () => {
    const { container: el } = await mount(
      <DetailPage definition={dcPage} payload={dcs} sources={DC_READY} nowMs={NOW} />,
    );
    expect(layoutOf(el)).toBe("compact-portrait");
    // §15.2's lede is on screen in portrait…
    expect(el.textContent).toContain("Выберите DC");

    await rotate(844, 390);
    expect(layoutOf(el)).toBe("compact-landscape");
    // …and §15.3 takes it away, together with the breadcrumb, when the
    // whole viewport is 390 px tall. The title and the status stay.
    expect(el.textContent).not.toContain("Выберите DC");
    expect(el.textContent).toContain("Data Centers");
    // R1: the rail, not a 300 px desktop master pane.
    const rail = el.querySelector<HTMLElement>('[data-testid="entity-selector"]');
    expect(rail?.className).toContain("detail-rail");
    expect(rail?.className).not.toContain("detail-master");

    await rotate(1280, 900);
    expect(layoutOf(el)).toBe("wide");
    expect(
      el.querySelector<HTMLElement>('[data-testid="entity-selector"]')?.className,
    ).toContain("detail-master");
    // §15.4: the detail column stops at a readable measure.
    expect(el.innerHTML).toContain("detail-readable");
  });
});

// --- §16.2: the bounded swipe and its mandatory pager --------------------

describe("entity paging (spec §16.2)", () => {
  it("shows the pager in EVERY layout, wrapping at both ends", async () => {
    const { container: el } = await mount(
      <DetailPage definition={dcPage} payload={dcs} sources={DC_READY} nowMs={NOW} />,
    );
    const prev = () =>
      el.querySelector<HTMLElement>('[data-testid="entity-pager-previous"]')!;
    const next = () => el.querySelector<HTMLElement>('[data-testid="entity-pager-next"]')!;

    // First entity selected: the previous button names the LAST one.
    expect(selected(el)).toBe(`DC ${dcs.dcs[0].dc}`);
    expect(prev().textContent).toContain(String(dcs.dcs[dcs.dcs.length - 1].dc));
    expect(next().textContent).toContain(String(dcs.dcs[1].dc));

    await act(async () => next().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(selected(el)).toBe(`DC ${dcs.dcs[1].dc}`);

    await act(async () => prev().dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(selected(el)).toBe(`DC ${dcs.dcs[0].dc}`);

    // The pager is the primary control, so it survives every mode — a
    // desktop reader gets no gesture at all.
    await rotate(1280, 900);
    expect(el.querySelector('[data-testid="entity-pager-next"]')).not.toBeNull();
  });

  it("moves one entity per swipe, left for next and right for previous", async () => {
    const { container: el } = await mount(
      <DetailPage definition={dcPage} payload={dcs} sources={DC_READY} nowMs={NOW} />,
    );
    await act(async () => swipe(hero(el), 300, 300 - 80));
    expect(selected(el)).toBe(`DC ${dcs.dcs[1].dc}`);

    await act(async () => swipe(hero(el), 200, 200 + 80));
    expect(selected(el)).toBe(`DC ${dcs.dcs[0].dc}`);
  });

  it("ignores a drag that starts in the left-edge dead zone (the system Back gesture)", async () => {
    const { container: el } = await mount(
      <DetailPage definition={dcPage} payload={dcs} sources={DC_READY} nowMs={NOW} />,
    );
    // Starts at x=8, well inside the 24 px strip, and travels far enough to
    // pass the threshold — this is exactly the Android/iOS back swipe.
    await act(async () => swipe(hero(el), 8, 8 + 160));
    expect(selected(el)).toBe(`DC ${dcs.dcs[0].dc}`);
  });

  it("gives the vertical axis priority, and ignores a short drag", async () => {
    const { container: el } = await mount(
      <DetailPage definition={dcPage} payload={dcs} sources={DC_READY} nowMs={NOW} />,
    );
    // A scroll: 80 px across, 120 px down.
    await act(async () => {
      const node = hero(el);
      node.dispatchEvent(pointer("pointerdown", 300, 300));
      node.dispatchEvent(pointer("pointermove", 260, 420));
      node.dispatchEvent(pointer("pointerup", 220, 420));
    });
    expect(selected(el)).toBe(`DC ${dcs.dcs[0].dc}`);

    // Below the 56 px threshold.
    await act(async () => swipe(hero(el), 300, 280));
    expect(selected(el)).toBe(`DC ${dcs.dcs[0].dc}`);
  });

  it("does not arm the gesture for a mouse, where the pager is the control", async () => {
    const { container: el } = await mount(
      <DetailPage definition={dcPage} payload={dcs} sources={DC_READY} nowMs={NOW} />,
    );
    await act(async () => {
      const node = hero(el);
      node.dispatchEvent(pointer("pointerdown", 300, 300, "mouse"));
      node.dispatchEvent(pointer("pointerup", 200, 300, "mouse"));
    });
    expect(selected(el)).toBe(`DC ${dcs.dcs[0].dc}`);
  });
});

// --- §15.3 + §19.1: a rotation resets nothing ----------------------------

describe("state across a rotation (spec §15.3, §19.1)", () => {
  it("keeps the entity, the tab, the accordion, the search and the open surface", async () => {
    const { container: el } = await mount(
      <DetailPage definition={dcPage} payload={dcs} sources={DC_READY} nowMs={NOW} />,
      "/page?entity=dc2&tab=endpoints",
    );

    // Set up a page in the middle of being read: an entity chosen, the
    // second tab open, its accordion collapsed by hand, a query typed and
    // an entity surface open.
    expect(selected(el)).toBe("DC 2");
    const tab = () => el.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    expect(tab()?.textContent).toBe("Точки");

    const search = el.querySelector<HTMLInputElement>('input[type="search"]');
    if (search) type(search, "edge");

    const row = el.querySelector<HTMLElement>("#endpoints-panel button[aria-label]");
    if (row) click(row);
    const surfaceOpen = document.querySelector('[role="dialog"]') !== null;

    const accordion = el.querySelector<HTMLElement>("#endpoints-panel")!;
    const header = accordion.previousElementSibling as HTMLElement;
    click(header);
    const expandedBefore = header.getAttribute("aria-expanded");

    // …now rotate the phone, twice.
    await rotate(844, 390);
    expect(layoutOf(el)).toBe("compact-landscape");
    await rotate(360, 640);
    expect(layoutOf(el)).toBe("compact-portrait");

    expect(selected(el)).toBe("DC 2");
    expect(tab()?.textContent).toBe("Точки");
    expect(
      el.querySelector<HTMLElement>("#endpoints-panel")!.previousElementSibling!.getAttribute(
        "aria-expanded",
      ),
    ).toBe(expandedBefore);
    if (search) {
      expect(el.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("edge");
    }
    expect(document.querySelector('[role="dialog"]') !== null).toBe(surfaceOpen);
  });

  it("keeps a ranking's own search and sort across a rotation", async () => {
    const { container: el } = await mount(
      <DetailPage definition={writersPage} payload={meWriters} sources={WRITERS_READY} nowMs={NOW} />,
    );
    const search = el.querySelector<HTMLInputElement>('input[type="search"]')!;
    type(search, "writer #1");
    const select = el.querySelector<HTMLSelectElement>("select")!;
    act(() => {
      select.value = "rtt_ema_ms";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const matches = el.querySelectorAll("#writers-panel li").length;
    expect(matches).toBeGreaterThan(0);

    await rotate(844, 390);
    await rotate(1280, 900);

    // The section was never remounted, so its LOCAL state (the query) is
    // still there alongside the page-level sort slot.
    expect(el.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("writer #1");
    expect(el.querySelector<HTMLSelectElement>("select")?.value).toBe("rtt_ema_ms");
    expect(el.querySelectorAll("#writers-panel li").length).toBe(matches);
  });
});

// --- L4: the released sort slot, and the shortcut that refills it --------

describe("summary shortcut after the sort slot is released (Task 4 review L4)", () => {
  it("re-applies the sort a reader cleared with the default-order option", async () => {
    const { container: el } = await mount(
      <DetailPage definition={writersPage} payload={meWriters} sources={WRITERS_READY} nowMs={NOW} />,
    );
    const select = () => el.querySelector<HTMLSelectElement>("select")!;
    const tile = Array.from(el.querySelectorAll("button")).find((b) =>
      b.textContent?.startsWith("Самый медленный"),
    )!;
    // The second span in a row is the identity; the first is the rank.
    const identities = () =>
      Array.from(el.querySelectorAll("#writers-panel li")).map(
        (li) => li.querySelectorAll("span")[1]?.textContent ?? "",
      );

    // The control names the default order explicitly — that is the option
    // the reader needs in order to get back to it.
    const options = Array.from(select().options);
    expect(options[0]?.value).toBe("bound_clients");
    expect(options[0]?.textContent).toContain("умолчанию");

    const byScore = identities();

    click(tile);
    expect(select().value).toBe("rtt_ema_ms");
    expect(identities()).not.toEqual(byScore);

    // Back to the default: the slot is released, not overwritten.
    act(() => {
      select().value = "bound_clients";
      select().dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(identities()).toEqual(byScore);

    // …and the tile can fill it again, which is the half of L4 that only
    // an empty slot makes possible.
    click(tile);
    expect(select().value).toBe("rtt_ema_ms");
    expect(identities()).not.toEqual(byScore);
  });
});

// --- §21: tabs, roving focus --------------------------------------------

describe("keyboard and a11y (spec §21)", () => {
  it("wires the tabs as tablist/tab/tabpanel with a single tab stop", async () => {
    const { container: el } = await mount(
      <DetailPage definition={dcPage} payload={dcs} sources={DC_READY} nowMs={NOW} />,
    );
    const list = el.querySelector<HTMLElement>('[role="tablist"]')!;
    const tabs = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]'));
    expect(tabs).toHaveLength(2);

    const panelId = tabs[0].getAttribute("aria-controls")!;
    const panel = document.getElementById(panelId)!;
    expect(panel.getAttribute("role")).toBe("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0].id);

    // One tab stop: the selected tab, everything else -1.
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1]);

    // Arrow moves the FOCUS without switching the panel (manual
    // activation — switching re-resolves a section list of up to two
    // thousand leaves).
    press(list, "ArrowRight");
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");

    // Activating a tab writes the URL (ruling R3), so it is a navigation.
    await act(async () => tabs[1].dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(el.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Точки");
  });

  it("makes the entity strip one tab stop with arrow-key movement", async () => {
    const { container: el } = await mount(
      <DetailPage definition={dcPage} payload={dcs} sources={DC_READY} nowMs={NOW} />,
    );
    const strip = el.querySelector<HTMLElement>('[data-testid="entity-selector"]')!;
    const chips = Array.from(strip.querySelectorAll<HTMLElement>("button"));
    expect(chips.filter((c) => c.tabIndex === 0)).toHaveLength(1);

    press(strip, "ArrowRight");
    expect(document.activeElement).toBe(chips[1]);
    press(strip, "End");
    expect(document.activeElement).toBe(chips[chips.length - 1]);
    press(strip, "ArrowRight");
    // Wraps rather than dead-ending.
    expect(document.activeElement).toBe(chips[0]);
  });

  it("makes a fifty-row ranking one tab stop", async () => {
    const { container: el } = await mount(
      <DetailPage definition={writersPage} payload={meWriters} sources={WRITERS_READY} nowMs={NOW} />,
    );
    const list = el.querySelector<HTMLElement>("#writers-panel ol")!;
    const rows = Array.from(list.querySelectorAll<HTMLElement>("li > button"));
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.filter((r) => r.tabIndex === 0)).toHaveLength(1);

    press(list, "ArrowDown");
    expect(document.activeElement).toBe(rows[1]);
  });
});
