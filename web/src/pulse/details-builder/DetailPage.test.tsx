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
import {
  aggregateSources,
  resolveQuerySource,
  type PageSourcesState,
  type QuerySourceInput,
} from "./sources";
import { validateDetailSearch } from "./state";
import type { DcStatus, DcStatusData } from "../../realtime/topics";

// A fixed clock and a fixed payload stamp: the header renders an AGE
// (§19.3), and an age measured against Date.now() would make this test
// depend on when it runs.
const FRESH_AT = 1_756_000_000_000;
const NOW = FRESH_AT + 125_000;

const dcKey = (dc: DcStatus): string => `dc${dc.dc}`;

const definition: DetailPageDefinition<DcStatusData, DcStatus> = {
  id: "test.dc",
  title: () => "Data Centers",
  description: () => "Выберите DC.",
  sources: [{ id: "tls", endpoint: "/api/telemt/tls-fingerprints", required: true }],
  navigation: {
    entities: {
      path: "dcs",
      entityKey: (item) => dcKey(item as DcStatus),
      label: (item) => `DC ${(item as DcStatus).dc}`,
    },
    selectEntity: (payload, key) => payload.dcs.find((dc) => dcKey(dc) === key) ?? payload.dcs[0] ?? null,
  },
  summary: [{ id: "load", label: () => "load", value: (dc) => dc.load, format: "decimal" }],
  sections: [
    {
      kind: "scalars",
      id: "routing",
      title: () => "Routing",
      defaultExpanded: true,
      // Bound as a scalar on purpose (§9.1) — must not reach a row.
      fields: [{ path: "dc" }, { path: "rtt_ms" }, { path: "endpoints" }],
    },
    { kind: "array", id: "endpoints", title: () => "endpoints[]", path: "endpoints" },
  ],
  unknownFields: { minMode: "extended" },
};

function sourcesFor(input: QuerySourceInput): PageSourcesState {
  return aggregateSources(definition.sources, { tls: resolveQuerySource("tls", input) });
}

const READY = sourcesFor({
  kind: "query",
  isPending: false,
  isError: false,
  data: dcs,
  dataUpdatedAt: FRESH_AT,
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

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

beforeEach(() => {
  window.scrollTo = () => {};
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  root = null;
  container = null;
});

describe("DetailPage header (spec §6, §19.3)", () => {
  it("renders the title, breadcrumb, page status and the AGE of the snapshot", async () => {
    const { container: el } = await mount(
      <DetailPage definition={definition} payload={dcs} sources={READY} breadcrumb="PULSE / DETAILS" nowMs={NOW} />,
    );
    const header = el.querySelector("header")!;
    expect(header.textContent).toContain("Data Centers");
    expect(header.textContent).toContain("PULSE / DETAILS");
    expect(header.textContent).toContain("Актуально");
    // 125 s old, rendered as an age and not as a bare timestamp.
    expect(header.textContent).toMatch(/назад/);
    // The absolute stamp stays reachable.
    expect(header.querySelector("[title]")?.getAttribute("title")).toBeTruthy();
  });
});

describe("DetailPage §14 states", () => {
  it("shows a skeleton, not a blank screen, while loading", async () => {
    const { container: el } = await mount(
      <DetailPage
        definition={definition}
        payload={null}
        sources={sourcesFor({ kind: "query", isPending: true, isError: false })}
        nowMs={NOW}
      />,
    );
    expect(el.querySelector(".animate-pulse")).not.toBeNull();
    expect(el.textContent).toContain("Загрузка");
  });

  it("names the reason for an unsupported source and points at an update, not a setting (R5)", async () => {
    const { container: el } = await mount(
      <DetailPage
        definition={definition}
        payload={null}
        sources={sourcesFor({
          kind: "query",
          isPending: false,
          isError: true,
          error: { code: "capability_absent" },
        })}
        nowMs={NOW}
      />,
    );
    expect(el.textContent).toContain("Недоступно в этой версии Telemt");
    expect(el.textContent).not.toContain("Выключено");
  });

  it("explains an unsupported source ONCE — the pills name the state in a word", async () => {
    const { container: el } = await mount(
      <DetailPage
        definition={definition}
        payload={null}
        sources={sourcesFor({
          kind: "query",
          isPending: false,
          isError: true,
          error: { code: "capability_absent" },
        })}
        nowMs={NOW}
      />,
    );
    const text = el.textContent ?? "";
    // The header pill and the attention card's pill used to repeat the same
    // sentence two centimetres apart; the sentence now belongs to the card.
    expect(text.split("Недоступно в этой версии Telemt")).toHaveLength(2);
    expect(text).toContain("Нет в этой версии");
  });

  it("keeps the sections on screen when a source goes stale (§14)", async () => {
    const { container: el } = await mount(
      <DetailPage
        definition={definition}
        payload={dcs}
        sources={sourcesFor({
          kind: "query",
          isPending: false,
          isError: true,
          error: { code: "telemt_unreachable" },
          data: dcs,
          dataUpdatedAt: FRESH_AT,
        })}
        nowMs={NOW}
      />,
    );
    expect(el.textContent).toContain("Устарело");
    // The working section is still there — a degraded source must not
    // replace it with a global error.
    expect(el.textContent).toContain("Routing");
    expect(el.textContent).toContain("rtt_ms");
  });

  it("offers a retry on a hard error", async () => {
    const { container: el } = await mount(
      <DetailPage
        definition={definition}
        payload={null}
        sources={sourcesFor({
          kind: "query",
          isPending: false,
          isError: true,
          error: { code: "internal_error" },
        })}
        onRetry={() => {}}
        nowMs={NOW}
      />,
    );
    expect(el.textContent).toContain("Ошибка источника");
    expect(el.textContent).toContain("Повторить");
  });
});

describe("DetailPage entity selection (spec §5.3, §19.2)", () => {
  it("opens the entity named in the URL", async () => {
    const { container: el } = await mount(
      <DetailPage definition={definition} payload={dcs} sources={READY} nowMs={NOW} />,
      "/page?entity=dc-203",
    );
    const selected = Array.from(el.querySelectorAll("button[aria-pressed]")).find(
      (b) => b.getAttribute("aria-pressed") === "true",
    );
    expect(selected?.textContent).toBe("DC -203");
  });

  it("says an entity is gone instead of silently showing another one", async () => {
    const { container: el } = await mount(
      <DetailPage definition={definition} payload={dcs} sources={READY} nowMs={NOW} />,
      "/page?entity=dc999",
    );
    expect(el.textContent).toContain("Выбранный элемент исчез из снимка");
    expect(el.textContent).toContain("Показать первый доступный");
    // No section is rendered under a gone selection — the numbers below
    // would belong to a different DC.
    expect(el.textContent).not.toContain("Routing");
  });
});

describe("DetailPage array rule (spec §10, §12.7)", () => {
  it("renders no array as a scalar row anywhere on the page", async () => {
    // The 10-endpoint DC: a comma-joined rendering would be unmistakable.
    const { container: el } = await mount(
      <DetailPage definition={definition} payload={dcs} sources={READY} nowMs={NOW} />,
      "/page?entity=dc-203",
    );
    const text = el.textContent ?? "";
    const dc = dcs.dcs[11];
    expect(dc.endpoints.length).toBe(10);
    expect(text).not.toContain(dc.endpoints.join(", "));
    expect(text).not.toMatch(/\d+\s*items/i);
    // It IS rendered — as its own block.
    expect(text).toContain("endpoints[]");
  });
});

// --- §18.2: a summary tile that shortcuts to a section's own control -----

interface Writer {
  writer_id: number;
  dc: number;
  degraded: boolean;
  bound_clients: number;
}

const degradedWriters = meWriters.writers.filter((w) => w.degraded).length;

// The tile "degraded" and the chip below it write the SAME filter key.
// That is the whole of §18.2: the shortcut is a second way to reach a
// state the ordinary control already offers, never a parallel mechanism.
const writersDefinition: DetailPageDefinition<typeof meWriters, typeof meWriters> = {
  id: "test.writers",
  title: () => "Writers",
  sources: [{ id: "tls", endpoint: "/api/telemt/tls-fingerprints", required: true }],
  summary: [
    {
      id: "degraded",
      label: () => "Degraded",
      value: () => degradedWriters,
      format: "integer",
      tone: "warn",
      shortcut: { filter: { key: "writers.degraded", value: true } },
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
      filters: [
        {
          key: "writers.degraded",
          label: () => "Только degraded",
          predicate: (item) => (item as Writer).degraded,
        },
      ],
    },
  ],
  unknownFields: { minMode: "extended" },
};

const WRITERS_READY = aggregateSources(writersDefinition.sources, {
  tls: resolveQuerySource("tls", {
    kind: "query",
    isPending: false,
    isError: false,
    data: meWriters,
    dataUpdatedAt: FRESH_AT,
  }),
});

function rankingRows(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>("#writers-panel li"));
}

function byText(el: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

describe("DetailPage summary shortcut (spec §18.2)", () => {
  it("applies the section's filter from the tile, leaving the ordinary control usable", async () => {
    const { container: el } = await mount(
      <DetailPage definition={writersDefinition} payload={meWriters} sources={WRITERS_READY} nowMs={NOW} />,
    );
    expect(degradedWriters).toBeGreaterThan(0);
    expect(rankingRows(el)).toHaveLength(20);

    const chip = byText(el, "Только degraded");
    expect(chip.getAttribute("aria-pressed")).toBe("false");

    // The tile is a button, and pressing it filters the ranking. Matched
    // by substring: a `warn`/`bad` tile also carries §21's non-colour cue —
    // a marker glyph plus the tone as sr-only text.
    const tile = Array.from(el.querySelectorAll("button")).find((b) =>
      b.textContent?.startsWith("Degraded"),
    )!;
    act(() => tile.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(rankingRows(el)).toHaveLength(degradedWriters);

    // The plain control is still there, now showing the state the shortcut
    // put it in — and one press clears it again.
    expect(byText(el, "Только degraded").getAttribute("aria-pressed")).toBe("true");
    act(() =>
      byText(el, "Только degraded").dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(rankingRows(el)).toHaveLength(20);
  });
});
