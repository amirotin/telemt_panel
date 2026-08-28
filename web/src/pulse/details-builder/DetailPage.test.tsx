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
import { dcs } from "./__fixtures__";
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
    expect(el.textContent).toContain("Данные устарели");
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
