import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_MEMORY_STATE,
  detailPageReducer,
  initialMemoryState,
  selectEntity,
  useDetailPageState,
  validateDetailSearch,
  type DetailPageStateApi,
  type MemoryState,
} from "./state";

describe("URL search validation (ruling R3)", () => {
  it("keeps entity and tab, and nothing else", () => {
    expect(validateDetailSearch({ entity: "dc:-203", tab: "writers", junk: 1 })).toEqual({
      entity: "dc:-203",
      tab: "writers",
    });
  });

  it("is total: junk degrades to no selection rather than throwing", () => {
    expect(validateDetailSearch({ entity: 42, tab: null })).toEqual({});
    expect(validateDetailSearch({ entity: "   " })).toEqual({});
    expect(validateDetailSearch({})).toEqual({});
  });

  it("caps an absurdly long value instead of putting it in the history entry", () => {
    const long = "x".repeat(1000);
    expect(validateDetailSearch({ entity: long }).entity).toHaveLength(256);
  });
});

describe("entity selection across realtime frames (spec §19.2)", () => {
  const keys = ["dc:1", "dc:2", "dc:-203"];

  it("resolves a key the payload still carries", () => {
    expect(selectEntity(keys, "dc:2")).toEqual({
      status: "selected",
      key: "dc:2",
      fallback: "dc:1",
    });
  });

  it("gives a disappeared entity an explicit gone state, not a crash", () => {
    expect(selectEntity(keys, "dc:999")).toEqual({
      status: "gone",
      key: "dc:999",
      fallback: "dc:1",
    });
  });

  it("does not silently substitute another entity", () => {
    const gone = selectEntity(keys, "dc:999");
    expect(gone.status).toBe("gone");
    expect(gone.key).toBe("dc:999");
  });

  it("survives an empty payload", () => {
    expect(selectEntity([], "dc:1")).toEqual({ status: "gone", key: "dc:1", fallback: null });
    expect(selectEntity([], undefined)).toEqual({ status: "none", key: null, fallback: null });
  });
});

describe("detailPageReducer", () => {
  const base = initialMemoryState();

  it("starts from the documented empty state", () => {
    expect(base.searchQuery).toBe("");
    expect(base.filters).toEqual({});
    expect(base.expandedSections.size).toBe(0);
    expect(base.visibleLimits).toEqual({});
  });

  it("copies the sets it is seeded with, so a shared definition cannot be mutated", () => {
    const seed: Partial<MemoryState> = { expandedSections: new Set(["a"]) };
    const state = initialMemoryState(seed);
    expect(state.expandedSections).not.toBe(seed.expandedSections);
    expect([...state.expandedSections]).toEqual(["a"]);
  });

  it("returns the SAME object for a no-op action (§19.1: no gratuitous re-creation)", () => {
    expect(detailPageReducer(base, { type: "setSearchQuery", value: "" })).toBe(base);
    expect(detailPageReducer(base, { type: "clearFilters" })).toBe(base);
    expect(detailPageReducer(base, { type: "closeSurface" })).toBe(base);
    expect(detailPageReducer(base, { type: "setSectionExpanded", id: "x", expanded: false })).toBe(
      base,
    );
  });

  it("toggles sections and records independently", () => {
    let state = detailPageReducer(base, { type: "toggleSection", id: "floor" });
    state = detailPageReducer(state, { type: "toggleRecord", id: "writer-3" });
    expect([...state.expandedSections]).toEqual(["floor"]);
    expect([...state.expandedRecords]).toEqual(["writer-3"]);
    state = detailPageReducer(state, { type: "toggleSection", id: "floor" });
    expect([...state.expandedSections]).toEqual([]);
  });

  it("sets and clears one filter without touching the others", () => {
    let state = detailPageReducer(base, { type: "setFilter", key: "degraded", value: true });
    state = detailPageReducer(state, { type: "setFilter", key: "dc", value: "-203" });
    expect(state.filters).toEqual({ degraded: true, dc: "-203" });
    state = detailPageReducer(state, { type: "setFilter", key: "dc", value: undefined });
    expect(state.filters).toEqual({ degraded: true });
  });

  it("only ever grows a visible limit (§18.3)", () => {
    let state = detailPageReducer(base, { type: "revealMore", id: "writers", step: 20, initial: 20 });
    expect(state.visibleLimits["writers"]).toBe(40);
    state = detailPageReducer(state, { type: "revealMore", id: "writers", step: 20, initial: 20 });
    expect(state.visibleLimits["writers"]).toBe(60);
  });

  it("drops the sort key entirely rather than leaving an undefined field", () => {
    const sorted = detailPageReducer(base, {
      type: "setSort",
      sort: { key: "total", direction: "desc" },
    });
    expect(sorted.sort).toEqual({ key: "total", direction: "desc" });
    const cleared = detailPageReducer(sorted, { type: "setSort", sort: undefined });
    expect("sort" in cleared).toBe(false);
  });

  it("resets to the initial state on demand", () => {
    const dirty = detailPageReducer(base, { type: "setSearchQuery", value: "ja3" });
    expect(detailPageReducer(dirty, { type: "reset" })).toEqual(EMPTY_MEMORY_STATE);
  });
});

// --- the hook, against a real (memory-history) router --------------------

function makeRouter(initialUrl: string, onState: (api: DetailPageStateApi) => void) {
  const rootRoute = createRootRoute();
  const pageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/page",
    validateSearch: validateDetailSearch,
    component: function Page() {
      onState(useDetailPageState({ pageId: "dev.dc" }));
      return null;
    },
  });
  return createRouter({
    routeTree: rootRoute.addChildren([pageRoute]),
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });
}

describe("useDetailPageState (ruling R3: entity/tab in the URL, the rest in memory)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let api: DetailPageStateApi;

  async function mount(url: string) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const router = makeRouter(url, (next) => {
      api = next;
    });
    await act(async () => {
      root.render(<RouterProvider router={router as never} />);
      await router.load();
    });
    return router;
  }

  beforeEach(() => {
    // TanStack Router calls window.scrollTo on every navigation; jsdom has
    // no layout and logs "Not implemented" for each one. Stubbing it keeps
    // the CI output about the tests.
    window.scrollTo = () => {};
  });

  afterEach(() => {
    if (root) act(() => root.unmount());
    if (container) container.remove();
  });

  it("reads the selected entity and active tab out of the URL", async () => {
    await mount("/page?entity=dc%3A-203&tab=writers");
    expect(api.state.selectedEntityKey).toBe("dc:-203");
    expect(api.state.activeTab).toBe("writers");
  });

  it("writes a new entity back into the URL", async () => {
    const router = await mount("/page");
    expect(api.state.selectedEntityKey).toBeUndefined();
    await act(async () => {
      api.selectEntityKey("dc:5");
      await router.invalidate();
    });
    expect(router.state.location.search).toMatchObject({ entity: "dc:5" });
    expect(api.state.selectedEntityKey).toBe("dc:5");
  });

  it("keeps filters, search, accordions and limits OUT of the URL", async () => {
    const router = await mount("/page");
    await act(async () => {
      api.setSearchQuery("ja3");
      api.setFilter("degraded", true);
      api.toggleSection("floor");
      api.revealMore("writers", 20, 20);
    });
    expect(api.state.searchQuery).toBe("ja3");
    expect(api.state.filters).toEqual({ degraded: true });
    expect([...api.state.expandedSections]).toEqual(["floor"]);
    expect(api.state.visibleLimits["writers"]).toBe(40);
    expect(router.state.location.search).toEqual({});
  });

  it("survives a realtime push: nothing here holds a payload (§19.1)", async () => {
    // The invariant is structural — page state has no payload field, so a
    // new frame cannot reach it. Re-rendering the whole tree (what a frame
    // does) must therefore leave every field untouched.
    const router = await mount("/page?entity=dc%3A-203&tab=writers");
    await act(async () => {
      api.setSearchQuery("ja3");
      api.setFilter("degraded", true);
      api.toggleSection("floor");
      api.toggleRecord("writer-3");
      api.revealMore("writers", 20, 20);
      api.openSurface("writer-3");
    });
    const before = {
      entity: api.state.selectedEntityKey,
      tab: api.state.activeTab,
      searchQuery: api.state.searchQuery,
      filters: api.state.filters,
      sections: [...api.state.expandedSections],
      records: [...api.state.expandedRecords],
      limits: api.state.visibleLimits,
      surface: api.state.openSurfaceKey,
    };
    // Three consecutive "frames".
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await router.invalidate();
      });
    }
    expect({
      entity: api.state.selectedEntityKey,
      tab: api.state.activeTab,
      searchQuery: api.state.searchQuery,
      filters: api.state.filters,
      sections: [...api.state.expandedSections],
      records: [...api.state.expandedRecords],
      limits: api.state.visibleLimits,
      surface: api.state.openSurfaceKey,
    }).toEqual(before);
  });

  it("keeps the state object referentially stable across a no-op re-render", async () => {
    const router = await mount("/page");
    const first = api.state;
    await act(async () => {
      await router.invalidate();
    });
    expect(api.state).toBe(first);
  });

  it("closes the detail surface only when asked", async () => {
    await mount("/page");
    await act(async () => api.openSurface("writer-9"));
    expect(api.state.openSurfaceKey).toBe("writer-9");
    await act(async () => api.closeSurface());
    expect(api.state.openSurfaceKey).toBeUndefined();
  });
});
