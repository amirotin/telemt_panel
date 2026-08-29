// Checkpoint R5-WEB, the automatable half: the §27.4 completeness equation
// over the RECORDED Telemt 3.5.5 status payload (46 limits, eight permits,
// six planes) plus the synthetic session page, and the domain rules the page
// depends on — the plane/`partial[]` pairing, the close selector, the cursor
// continuation.

import { describe, expect, it } from "vitest";
import { ru } from "../../../i18n";
import {
  webSessionRef,
  webSessionRows,
  webSessionsAll,
  webSessionsFirstPage,
  webSessionsManagerBusy,
  webSessionsSecondPage,
  webStatusNoListener,
  webStatusPartialPlanes,
  webStatusRunning,
} from "../__fixtures__";
import {
  WEB_PLANES,
  isWebPlaneBusy,
  webCloseSelector,
  webFilterSummary,
  webPagePayload,
  webRuntimeInstance,
  type WebPagePayload,
} from "../../diag/web.helpers";
import { classifyValue, resolveSections } from "../resolveSections";
import type { CollectionSectionInstance, ScalarSectionInstance } from "../resolveSections";
import {
  WEB_CARRIERS,
  WEB_FILTER_CARRIER,
  WEB_FILTER_STATE,
  WEB_FILTER_USER,
  WEB_SESSION_STATES,
  webLifecycleTone,
  webPageDefinition,
  webSessionKey,
} from "./web";
import type { WebSessionRow } from "../../../lib/api/generated/types.gen";

const running = webPagePayload(webStatusRunning, [webSessionsAll]) as WebPagePayload;
const overviewOnly = webPagePayload(webStatusRunning, null) as WebPagePayload;
const closed = webPagePayload(webStatusNoListener, null) as WebPagePayload;
const partial = webPagePayload(webStatusPartialPlanes, null) as WebPagePayload;

function resolveFor(context: WebPagePayload) {
  return resolveSections({ definition: webPageDefinition, context });
}

function sectionById(context: WebPagePayload, id: string) {
  const section = resolveFor(context).sections.find((s) => s.id === id);
  if (section === undefined) throw new Error(`no section ${id}`);
  return section;
}

describe("WEB page definition — the recorded status payload", () => {
  it("loses nothing: the §27.4 equation closes on every shape", () => {
    for (const [name, context] of [
      ["running + sessions", running],
      ["running, overview only", overviewOnly],
      ["no WEB listener", closed],
      ["four planes contended", partial],
    ] as const) {
      const result = resolveFor(context);
      expect(
        result.lostPaths,
        `${name}: paths accounted for by nothing:\n${result.lostPaths.join("\n")}`,
      ).toEqual([]);
      // …and the three terms partition the whole, with nothing counted
      // twice (which would hide a loss somewhere else).
      const union = new Set([
        ...result.consumedPaths,
        ...result.ignoredPaths.map((p) => p.path),
        ...result.unknownPaths,
      ]);
      expect(union.size, name).toBe(result.allPaths.length);
    }
  });

  it("renders the whole payload — nothing falls into the unknown tail", () => {
    expect(resolveFor(running).unknownPaths).toEqual([]);
  });

  it("still catches a field a future Telemt adds", () => {
    // The guard itself must not pass vacuously: a key nobody bound has to
    // reach the §24 tail rather than vanish.
    const future = {
      ...running,
      runtime: { ...running.runtime!, a_field_from_a_future_telemt: 1 },
    } as unknown as WebPagePayload;
    const result = resolveFor(future);
    expect(result.unknownPaths).toEqual(["runtime.a_field_from_a_future_telemt"]);
    expect(result.lostPaths).toEqual([]);
  });

  it("keeps the limits map and the capture policy forward-compatible", () => {
    // Both are ungrouped dynamic maps, so a knob added by a Telemt bump
    // becomes a ROW, not a lost leaf.
    const future = {
      ...running,
      runtime: {
        ...running.runtime!,
        limits: { ...running.runtime!.limits, a_limit_from_a_future_telemt: 1 },
      },
    } as unknown as WebPagePayload;
    const result = resolveFor(future);
    expect(result.unknownPaths).toEqual([]);
    expect(result.consumedPaths).toContain("runtime.limits.a_limit_from_a_future_telemt");
  });

  it("pins the recorded payload's shape, so a Telemt bump shows up here", () => {
    // The counts are the RECORDING's, not a guess: 46 [web.limits] keys,
    // eight semaphores, ten capture-policy keys, six planes.
    expect(Object.keys(webStatusRunning.runtime!.limits)).toHaveLength(46);
    expect(webStatusRunning.runtime!.permits).toHaveLength(8);
    expect(Object.keys(webStatusRunning.runtime!.debug!.policy)).toHaveLength(10);
    expect(WEB_PLANES).toHaveLength(6);
  });
});

describe("the six status planes", () => {
  it("reads a contended plane as BUSY, not as absent", () => {
    // Telemt sends the plane as an explicit null AND names it in partial[].
    expect(partial.runtime?.manager).toBeNull();
    expect(partial.runtime?.partial).toContain("manager");
    expect(isWebPlaneBusy(partial, "manager")).toBe(true);
    // …while a plane that answered is not busy, and neither is a payload
    // that has no runtime at all.
    expect(isWebPlaneBusy(partial, "streams")).toBe(false);
    expect(isWebPlaneBusy(closed, "manager")).toBe(false);
    expect(isWebPlaneBusy(null, "manager")).toBe(false);
  });

  it("keeps the busy plane's section on screen with its rows absent", () => {
    // §10.3: "the field is here and it is empty" must look different from
    // "the field never arrived" — the section stays, the badge explains it.
    const section = sectionById(partial, "manager") as ScalarSectionInstance;
    expect(section.kind).toBe("scalars");
    expect(section.rows.every((row) => !row.present)).toBe(true);
    // The plane that DID answer still renders real values.
    const streams = sectionById(partial, "streams") as ScalarSectionInstance;
    expect(streams.rows.some((row) => row.present)).toBe(true);
  });
});

describe("the permits table", () => {
  it("turns Telemt's tuple array into records the resolver can render", () => {
    const permits = running.runtime!.permits;
    expect(permits).toHaveLength(8);
    expect(permits[0]).toEqual({
      name: "http_connections",
      used: 0,
      available: 1024,
      capacity: 1024,
      closed: false,
    });
    // Never an array-of-arrays: §12.7 forbids a collection degrading into
    // a scalar row, and a tuple would have rendered as exactly that.
    const section = sectionById(running, "permits") as CollectionSectionInstance;
    expect(section.kind).toBe("array");
    expect(section.items).toHaveLength(8);
    expect(classifyValue(section.items[0])).toBe("object");
  });
});

describe("the sessions tab", () => {
  it("keys every row by Telemt's own opaque reference", () => {
    const list = sectionById(running, "sessions") as CollectionSectionInstance;
    expect(list.kind).toBe("entityList");
    expect(list.items).toHaveLength(webSessionRows.length);
    expect(new Set(list.itemKeys).size).toBe(webSessionRows.length);
    expect(list.itemKeys[0]).toBe(webSessionRows[0]!.session_ref);
    expect(webSessionKey({ session_ref: "ws1.aa.01" })).toBe("ws1.aa.01");
  });

  it("accumulates cursor pages into one collection, in order and without gaps", () => {
    const paged = webPagePayload(webStatusRunning, [
      webSessionsFirstPage,
      webSessionsSecondPage,
    ]) as WebPagePayload;
    expect(paged.sessions?.rows).toHaveLength(24);
    expect(new Set(paged.sessions?.rows.map((r) => r.session_ref)).size).toBe(24);
    // The page meta comes from the LAST page: that is the scan the reader
    // is looking at the tail of.
    expect(paged.sessions?.next_cursor).toBeNull();
    expect(paged.sessions?.scanned).toBe(24);
  });

  it("offers a continuation exactly while Telemt hands one back", () => {
    const first = webPagePayload(webStatusRunning, [webSessionsFirstPage]) as WebPagePayload;
    expect(first.sessions?.next_cursor).toBe(webSessionRef(20));
    expect(
      (webPagePayload(webStatusRunning, [webSessionsAll]) as WebPagePayload).sessions?.next_cursor,
    ).toBeNull();
  });

  it("reads a contended manager lock as busy, not as an empty registry", () => {
    // 200 OK with no rows and partial:["manager"]. The scan section is what
    // says so; the list must not be read as "there are no sessions".
    const busy = webPagePayload(webStatusRunning, [webSessionsManagerBusy]) as WebPagePayload;
    expect(busy.sessions?.rows).toEqual([]);
    expect(busy.sessions?.partial).toEqual(["manager"]);
    const section = sectionById(busy, "sessions_partial") as CollectionSectionInstance;
    expect(section.items).toEqual(["manager"]);
  });

  it("filters on the vocabularies Telemt actually sends", () => {
    const list = sectionById(running, "sessions") as CollectionSectionInstance;
    const definition = webPageDefinition.sections.find((s) => s.id === "sessions");
    const filters = (definition as { filters?: { key: string }[] }).filters ?? [];
    expect(filters.map((f) => f.key)).toEqual([
      WEB_FILTER_CARRIER,
      WEB_FILTER_STATE,
      WEB_FILTER_USER,
    ]);
    // Every carrier the rows carry is one the filter offers.
    const carriers = new Set(list.items.map((item) => (item as WebSessionRow).carrier));
    for (const carrier of carriers) {
      expect(WEB_CARRIERS as readonly string[]).toContain(carrier);
    }
    const states = new Set(list.items.map((item) => (item as WebSessionRow).state));
    for (const state of states) {
      expect(WEB_SESSION_STATES as readonly string[]).toContain(state);
    }
  });

  it("derives the user options from the rows, not from a fixed list", () => {
    const definition = webPageDefinition.sections.find((s) => s.id === "sessions");
    const filters =
      (definition as { filters?: { key: string; optionsFrom?: (i: unknown[]) => unknown[] }[] })
        .filters ?? [];
    const userFilter = filters.find((f) => f.key === WEB_FILTER_USER)!;
    const options = userFilter.optionsFrom?.(webSessionRows) as { value: string }[];
    expect(options.map((o) => o.value)).toEqual(["alice", "web-user"]);
  });
});

describe("the close action", () => {
  it("closes ONE session by its reference", () => {
    expect(webCloseSelector({ kind: "session", ref: "ws1.aa.01" })).toEqual({
      kind: "refs",
      session_refs: ["ws1.aa.01"],
    });
  });

  it("turns the reader's filters into Telemt's own filter selector", () => {
    expect(
      webCloseSelector({
        kind: "filter",
        filters: { [WEB_FILTER_CARRIER]: "websocket", [WEB_FILTER_USER]: "web-user" },
      }),
    ).toEqual({ kind: "filter", carrier: "websocket", user: "web-user" });
  });

  it("asks for `all` when no filter is set, rather than a selector Telemt rejects", () => {
    // An empty filter selector is a 400 on Telemt's side. `all` is the
    // honest request — and Telemt refuses it while issuance is enabled,
    // which tells the operator to switch WEB off first instead of handing
    // them a silent no-op.
    expect(webCloseSelector({ kind: "filter", filters: {} })).toEqual({ kind: "all" });
    // A filter set to the "any" sentinel is the same thing as no filter.
    expect(webCloseSelector({ kind: "filter", filters: { [WEB_FILTER_STATE]: "" } })).toEqual({
      kind: "all",
    });
  });

  it("summarises the filter the confirmation dialog is about to apply", () => {
    expect(
      webFilterSummary({ [WEB_FILTER_CARRIER]: "https", [WEB_FILTER_STATE]: "healthy" }, ru),
    ).toBe(`${ru.details.pages.web.filterCarrier}: https · ${ru.details.pages.web.filterState}: healthy`);
    expect(webFilterSummary({}, ru)).toBeNull();
  });

  it("has no runtime fence to offer while WEB is off — so the action cannot fire", () => {
    expect(webRuntimeInstance(running)).toBe("0123456789abcdef0123456789abcdef");
    expect(webRuntimeInstance(closed)).toBeNull();
    expect(webRuntimeInstance(null)).toBeNull();
  });
});

describe("the lifecycle tone", () => {
  it("is good while running, warn while moving, bad only on a missed deadline", () => {
    expect(webLifecycleTone("running")).toBe("good");
    expect(webLifecycleTone("starting")).toBe("warn");
    expect(webLifecycleTone("draining")).toBe("warn");
    expect(webLifecycleTone("deadline_exceeded")).toBe("bad");
  });

  it("is NEUTRAL for a WEB runtime that is deliberately off", () => {
    // Painting a configuration red trains an operator to ignore the colour.
    expect(webLifecycleTone("no_web_listener")).toBe("neutral");
    expect(webLifecycleTone("drained")).toBe("neutral");
    expect(webLifecycleTone(undefined)).toBe("neutral");
  });
});
