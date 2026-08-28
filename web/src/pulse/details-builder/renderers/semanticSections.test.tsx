import { act, StrictMode, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  events,
  initialization,
  initializationSkippedCount,
  meQuality,
  summary,
  tlsFingerprints,
  tlsRowsPerScope,
  zeroAll,
} from "../__fixtures__";
import type {
  BreakdownSectionDefinition,
  DetailPageDefinition,
  FilterValue,
  RankingSectionDefinition,
  SectionDefinition,
  SortState,
  TimelineSectionDefinition,
} from "../model";
import {
  resolveSections,
  type CollectionSectionInstance,
  type CustomSectionInstance,
} from "../resolveSections";
import { BreakdownSection } from "./BreakdownSection";
import { CustomSection } from "./CustomSection";
import { RankingSection } from "./RankingSection";
import { TimelineSection } from "./TimelineSection";
import { QUALITY_CHART_RENDERER } from "./customRenderers";
import type { DetailRenderContext } from "./context";

// One fixed clock for every relative age below, so a timestamp assertion is
// a fact about the formatter and not about when the suite ran.
const NOW = 1_756_000_125_000;

function toggled(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

// Harness holds the slice of PageState the renderers read — including the
// filter and sort slots §18.2's shortcut writes into — so a test can drive
// the whole interaction without a router or a reducer.
function Harness({ render }: { render: (ctx: DetailRenderContext) => ReactNode }) {
  const [sections, setSections] = useState<ReadonlySet<string>>(new Set());
  const [records, setRecords] = useState<ReadonlySet<string>>(new Set());
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [surface, setSurface] = useState<string | undefined>(undefined);
  const [filters, setFilters] = useState<Record<string, FilterValue>>({});
  const [sort, setSort] = useState<SortState | undefined>(undefined);
  const ctx: DetailRenderContext = {
    nowMs: NOW,
    mode: "extended",
    lookup: {},
    expandedSections: sections,
    toggleSection: (id) => setSections((prev) => toggled(prev, id)),
    expandedRecords: records,
    toggleRecord: (id) => setRecords((prev) => toggled(prev, id)),
    visibleLimit: (id, initial) => limits[id] ?? initial,
    revealMore: (id, step, initial) =>
      setLimits((prev) => ({ ...prev, [id]: (prev[id] ?? initial) + step })),
    filters,
    setFilter: (key, value) =>
      setFilters((prev) => {
        const next = { ...prev };
        if (value === undefined) delete next[key];
        else next[key] = value;
        return next;
      }),
    sort,
    setSort,
    openSurfaceKey: surface,
    openSurface: setSurface,
    closeSurface: () => setSurface(undefined),
  };
  return <>{render(ctx)}</>;
}

let mounted: { container: HTMLElement; root: Root } | null = null;

function render(node: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted = { container, root };
  return container;
}

function rerender(node: ReactNode): void {
  act(() => mounted!.root.render(node));
}

afterEach(() => {
  if (mounted) {
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
});

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

// React tracks an input's value on the DOM node, so a plain assignment is
// swallowed; going through the prototype setter is what makes the change
// event look like real typing.
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

function instanceOf<T>(
  definition: DetailPageDefinition<T, T>,
  context: T,
  id: string,
): CollectionSectionInstance {
  const found = resolveSections({ definition, context }).sections.find((s) => s.id === id);
  if (!found) throw new Error(`no section ${id}`);
  return found as CollectionSectionInstance;
}

function page<T>(section: SectionDefinition<T>): DetailPageDefinition<T, T> {
  return { id: "test", title: () => "test", sources: [], sections: [section] };
}

// --- BreakdownSection (§9.4) ---------------------------------------------

const badByClass: BreakdownSectionDefinition<typeof summary, unknown> = {
  kind: "breakdown",
  id: "bad-by-class",
  title: () => "connections_bad_by_class",
  path: "connections_bad_by_class",
  defaultExpanded: true,
};

const errorCodes: BreakdownSectionDefinition<typeof zeroAll, unknown> = {
  kind: "breakdown",
  id: "error-codes",
  title: () => "handshake_error_codes",
  path: "middle_proxy.handshake_error_codes",
  defaultExpanded: true,
};

const routeDrops: BreakdownSectionDefinition<typeof meQuality, unknown> = {
  kind: "breakdown",
  id: "route-drops",
  title: () => "route_drops",
  path: "route_drops",
  defaultExpanded: true,
};

function breakdownRows(container: HTMLElement, id: string): HTMLElement[] {
  const panel = container.querySelector<HTMLElement>(`#${id}-panel`)!;
  return Array.from(panel.querySelectorAll<HTMLElement>(":scope > div > div"));
}

describe("BreakdownSection (spec §9.4)", () => {
  it("gives each {class,total} pair ONE row, never two KV rows", () => {
    const instance = instanceOf(page(badByClass), summary, "bad-by-class");
    const el = render(
      <Harness render={(ctx) => <BreakdownSection instance={instance} ctx={ctx} />} />,
    );
    const panel = el.querySelector("#bad-by-class-panel")!;
    const classes = (summary.connections_bad_by_class ?? []).map((c) => c.class);
    for (const name of classes) expect(panel.textContent).toContain(name);
    // The pair's field NAMES never appear — that is the flattening this
    // renderer exists to replace.
    expect(panel.textContent).not.toContain("[0].class");
    expect(breakdownRows(el, "bad-by-class")).toHaveLength(classes.length);
  });

  it("shows each row's share of the section total as a percentage and a bar", () => {
    const instance = instanceOf(page(badByClass), summary, "bad-by-class");
    const el = render(
      <Harness render={(ctx) => <BreakdownSection instance={instance} ctx={ctx} />} />,
    );
    const panel = el.querySelector("#bad-by-class-panel")!;
    expect(panel.textContent).toMatch(/%/);
    const bars = panel.querySelectorAll('[aria-hidden="true"] > div');
    expect(bars.length).toBe((summary.connections_bad_by_class ?? []).length);
    expect((bars[0] as HTMLElement).style.width).toMatch(/%$/);
  });

  it("orders rows by size, largest first", () => {
    const instance = instanceOf(page(badByClass), summary, "bad-by-class");
    const el = render(
      <Harness render={(ctx) => <BreakdownSection instance={instance} ctx={ctx} />} />,
    );
    const sorted = [...(summary.connections_bad_by_class ?? [])].sort((a, b) => b.total - a.total);
    const rows = breakdownRows(el, "bad-by-class");
    rows.forEach((row, i) => expect(row.textContent).toContain(sorted[i].class));
  });

  it("renders a delta and a lifetime column when the binding provides them", () => {
    const instance = instanceOf(page(badByClass), summary, "bad-by-class");
    const first = (summary.connections_bad_by_class ?? [])[0];
    const withLifetime: BreakdownSectionDefinition<unknown, unknown> = {
      ...(badByClass as unknown as BreakdownSectionDefinition<unknown, unknown>),
      lifetime: (item) => (item as { total: number }).total * 2,
    };
    const el = render(
      <Harness
        render={(ctx) => (
          <BreakdownSection
            instance={instance}
            definition={withLifetime}
            ctx={ctx}
            deltas={{ [`connections_bad_by_class.${first.class}`]: 12 }}
          />
        )}
      />,
    );
    const panel = el.querySelector("#bad-by-class-panel")!;
    expect(panel.textContent).toContain("+12");
    expect(panel.textContent).toContain(String(first.total * 2));
  });

  it("says an EMPTY collection is empty, which is not the same as absent (§10.3)", () => {
    const instance = instanceOf(page(errorCodes), zeroAll, "error-codes");
    expect(instance.presence).toBe("empty");
    const el = render(
      <Harness render={(ctx) => <BreakdownSection instance={instance} ctx={ctx} />} />,
    );
    expect(el.querySelector("#error-codes-panel")!.textContent).toContain(
      "Нет элементов в текущем снимке",
    );
  });

  it("reads a dynamic-map group as pairs, key → counter", () => {
    const instance = instanceOf(page(routeDrops), meQuality, "route-drops");
    const el = render(
      <Harness render={(ctx) => <BreakdownSection instance={instance} ctx={ctx} />} />,
    );
    const panel = el.querySelector("#route-drops-panel")!;
    // The verbatim map key is the label (§11.2), its counter is the value.
    expect(panel.textContent).toContain("no_conn_total");
    expect(breakdownRows(el, "route-drops")).toHaveLength(
      Object.keys(meQuality.route_drops).length,
    );
  });
});

// --- TimelineSection (§9.5) ----------------------------------------------

const initTimeline: TimelineSectionDefinition<typeof initialization, unknown> = {
  kind: "timeline",
  id: "components",
  title: () => "Initialization sequence",
  path: "components",
  defaultExpanded: true,
  itemKey: (item) => String((item as { id: string }).id),
  status: (item) => String((item as { status: string }).status),
  step: (item) => String((item as { title: string }).title),
  details: (item) => (item as { details?: string }).details ?? null,
  durationMs: (item) => (item as { duration_ms: number }).duration_ms,
};

const eventTimeline: TimelineSectionDefinition<typeof events, unknown> = {
  kind: "timeline",
  id: "events",
  title: () => "events",
  path: "events",
  defaultExpanded: true,
  itemKey: (item) => String((item as { seq: number }).seq),
  status: (item) => String((item as { event_type: string }).event_type),
  step: (item) => String((item as { context: string }).context),
  atEpochMs: (item) => (item as { ts_epoch_secs: number }).ts_epoch_secs * 1000,
};

describe("TimelineSection (spec §9.5)", () => {
  it("renders one step per initialization component, in payload order", () => {
    const instance = instanceOf(page(initTimeline), initialization, "components");
    const el = render(
      <Harness
        render={(ctx) => (
          <TimelineSection instance={instance} definition={initTimeline as TimelineSectionDefinition<unknown, unknown>} ctx={ctx} />
        )}
      />,
    );
    const steps = el.querySelectorAll("#components-panel li");
    expect(steps).toHaveLength(initialization.components.length);
    initialization.components.forEach((component, i) => {
      expect(steps[i].textContent).toContain(component.title);
    });
  });

  it("carries the status, the details and the duration on the SAME step", () => {
    const instance = instanceOf(page(initTimeline), initialization, "components");
    const el = render(
      <Harness
        render={(ctx) => (
          <TimelineSection instance={instance} definition={initTimeline as TimelineSectionDefinition<unknown, unknown>} ctx={ctx} />
        )}
      />,
    );
    const skipped = el.querySelectorAll("#components-panel li")[
      initialization.components.length - 1
    ];
    expect(skipped.textContent).toContain("disabled by configuration");
    expect(skipped.textContent).toContain("skipped");
  });

  it("summarizes the sequence in the header the way the render does", () => {
    const instance = instanceOf(page(initTimeline), initialization, "components");
    const el = render(
      <Harness
        render={(ctx) => (
          <TimelineSection instance={instance} definition={initTimeline as TimelineSectionDefinition<unknown, unknown>} ctx={ctx} />
        )}
      />,
    );
    const header = el.querySelector("button[aria-expanded]")!;
    const ready = initialization.components.length - initializationSkippedCount;
    expect(header.textContent).toContain(`${ready} ready`);
    expect(header.textContent).toContain(`${initializationSkippedCount} skipped`);
  });

  it("shows an event's time relatively, with the absolute stamp on the element", () => {
    const instance = instanceOf(page(eventTimeline), events, "events");
    const el = render(
      <Harness
        render={(ctx) => (
          <TimelineSection instance={instance} definition={eventTimeline as TimelineSectionDefinition<unknown, unknown>} ctx={ctx} />
        )}
      />,
    );
    const first = el.querySelector("#events-panel li")!;
    const relative = first.querySelector<HTMLElement>("[title]")!;
    expect(relative.textContent).toContain("назад");
    // §13: the absolute rendering stays reachable from the relative one.
    expect(relative.title).not.toBe("");
    expect(relative.title).not.toBe(relative.textContent);
  });

  it("reveals 20 of the 50 events first, then the rest on request (§18.3)", () => {
    const instance = instanceOf(page(eventTimeline), events, "events");
    const el = render(
      <Harness
        render={(ctx) => (
          <TimelineSection instance={instance} definition={eventTimeline as TimelineSectionDefinition<unknown, unknown>} ctx={ctx} />
        )}
      />,
    );
    expect(el.querySelectorAll("#events-panel li")).toHaveLength(20);
    const more = Array.from(el.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Показать ещё"),
    )!;
    click(more);
    expect(el.querySelectorAll("#events-panel li")).toHaveLength(40);
  });
});

// --- RankingSection (§9.6, §19.2) ----------------------------------------

interface TlsRow {
  ja4: string;
  total: number;
  bad_or_probe: number;
  last_seen_epoch_secs: number;
}

const tlsRanking: RankingSectionDefinition<typeof tlsFingerprints, unknown> = {
  kind: "ranking",
  id: "by-fingerprint",
  title: () => "Ranked records",
  path: "by_fingerprint",
  defaultExpanded: true,
  itemKey: (item) => (item as TlsRow).ja4,
  identity: (item) => (item as TlsRow).ja4,
  score: (item) => (item as TlsRow).total,
  scoreKey: "total",
  scoreLabel: () => "observed",
  meta: (item) => `bad/probe ${(item as TlsRow).bad_or_probe}`,
  filters: [
    {
      key: "recent",
      label: () => "Недавние",
      predicate: (item) => (item as TlsRow).last_seen_epoch_secs >= 1_755_996_525,
    },
  ],
};

function rankingRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("#by-fingerprint-panel li"));
}

function identitiesIn(container: HTMLElement, id: string): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`#${id}-panel li`)).map(
    (row) => row.querySelector(".font-mono.font-semibold")?.textContent ?? "",
  );
}

function identities(container: HTMLElement): string[] {
  return identitiesIn(container, "by-fingerprint");
}

function rankingTree(instance: CollectionSectionInstance): ReactNode {
  return (
    <Harness
      render={(ctx) => (
        <RankingSection instance={instance} definition={tlsRanking as RankingSectionDefinition<unknown, unknown>} ctx={ctx} />
      )}
    />
  );
}

const tlsInstance = (payload: typeof tlsFingerprints) =>
  instanceOf(page(tlsRanking), payload, "by-fingerprint");

describe("RankingSection (spec §9.6, §18)", () => {
  it("ranks the first 20 of 50 records, numbered from 1", () => {
    const el = render(rankingTree(tlsInstance(tlsFingerprints)));
    const rows = rankingRows(el);
    expect(rows).toHaveLength(20);
    expect(rows[0].textContent).toMatch(/^1/);
    expect(rows[19].textContent).toMatch(/^20/);
    // The fixture's totals descend, so rank 1 really is the biggest.
    expect(rows[0].textContent).toContain(tlsFingerprints.by_fingerprint[0].ja4);
  });

  it("reveals the rest through «Показать ещё», never numbered pages", () => {
    const el = render(rankingTree(tlsInstance(tlsFingerprints)));
    const more = Array.from(el.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Показать ещё"),
    )!;
    click(more);
    expect(rankingRows(el)).toHaveLength(40);
    click(more);
    expect(rankingRows(el)).toHaveLength(tlsRowsPerScope);
  });

  it("filters by the search box without losing the ranking", () => {
    const el = render(rankingTree(tlsInstance(tlsFingerprints)));
    const search = el.querySelector<HTMLInputElement>('input[type="search"]')!;
    const needle = tlsFingerprints.by_fingerprint[3].ja4;
    type(search, needle);
    const rows = rankingRows(el);
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain(needle);
  });

  it("sorts by any numeric column the records carry", () => {
    const el = render(rankingTree(tlsInstance(tlsFingerprints)));
    const select = el.querySelector<HTMLSelectElement>("select")!;
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      "total",
      "auth_success",
      "bad_or_probe",
      "first_seen_epoch_secs",
      "last_seen_epoch_secs",
    ]);
    act(() => {
      select.value = "last_seen_epoch_secs";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const newest = [...tlsFingerprints.by_fingerprint].sort(
      (a, b) => b.last_seen_epoch_secs - a.last_seen_epoch_secs,
    )[0];
    expect(identities(el)[0]).toBe(newest.ja4);
  });

  it("opens every remaining field of a record in the adaptive surface (§17)", () => {
    const el = render(rankingTree(tlsInstance(tlsFingerprints)));
    click(rankingRows(el)[0].querySelector("button")!);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.textContent).toContain("ja3_raw");
    expect(dialog.textContent).toContain("first_seen_epoch_secs");
  });

  it("applies a domain filter from its own chip, and clears it again (§18.2)", () => {
    const el = render(rankingTree(tlsInstance(tlsFingerprints)));
    const chip = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Недавние",
    )!;
    const before = rankingRows(el).length;
    click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    const matching = tlsFingerprints.by_fingerprint.filter(
      (r) => r.last_seen_epoch_secs >= 1_755_996_525,
    ).length;
    expect(rankingRows(el)).toHaveLength(Math.min(20, matching));
    click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(rankingRows(el)).toHaveLength(before);
  });
});

describe("RankingSection frozen order (spec §19.2)", () => {
  // Payload B carries the SAME 50 records with a different ranking: the
  // last record becomes the biggest, which would move it from row 50 to
  // row 1 the instant it arrives.
  const payloadB: typeof tlsFingerprints = {
    ...tlsFingerprints,
    by_fingerprint: tlsFingerprints.by_fingerprint.map((row, i) =>
      i === tlsFingerprints.by_fingerprint.length - 1 ? { ...row, total: 999_999 } : row,
    ),
  };

  function focusSearch(el: HTMLElement): HTMLInputElement {
    const search = el.querySelector<HTMLInputElement>('input[type="search"]')!;
    act(() => search.focus());
    return search;
  }

  it("reorders freely while the reader is NOT interacting", () => {
    const el = render(rankingTree(tlsInstance(tlsFingerprints)));
    const first = identities(el)[0];
    rerender(rankingTree(tlsInstance(payloadB)));
    expect(identities(el)[0]).not.toBe(first);
    expect(identities(el)[0]).toBe(payloadB.by_fingerprint[49].ja4);
  });

  it("does NOT move a row under the reader while the search box has focus", () => {
    const el = render(rankingTree(tlsInstance(tlsFingerprints)));
    const before = identities(el);
    focusSearch(el);
    rerender(rankingTree(tlsInstance(payloadB)));
    expect(identities(el)).toEqual(before);
  });

  it("re-syncs as soon as the interaction ends", () => {
    const el = render(rankingTree(tlsInstance(tlsFingerprints)));
    const search = focusSearch(el);
    rerender(rankingTree(tlsInstance(payloadB)));
    act(() => search.blur());
    expect(identities(el)[0]).toBe(payloadB.by_fingerprint[49].ja4);
  });

  it("re-syncs on an explicit user action while the interaction continues", () => {
    const el = render(rankingTree(tlsInstance(tlsFingerprints)));
    focusSearch(el);
    rerender(rankingTree(tlsInstance(payloadB)));
    const refresh = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Обновить порядок",
    )!;
    expect(refresh).toBeDefined();
    click(refresh);
    expect(identities(el)[0]).toBe(payloadB.by_fingerprint[49].ja4);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("keeps the open surface's row in place, and shows an arrival at the end", () => {
    const el = render(rankingTree(tlsInstance(tlsFingerprints)));
    click(rankingRows(el)[0].querySelector("button")!);
    const before = identities(el);
    const withArrival: typeof tlsFingerprints = {
      ...payloadB,
      by_fingerprint: [
        { ...tlsFingerprints.by_fingerprint[0], ja4: "ja4:new-arrival", total: 1 },
        ...payloadB.by_fingerprint,
      ],
    };
    rerender(rankingTree(tlsInstance(withArrival)));
    // The frozen rows kept their places…
    expect(identities(el).slice(0, before.length)).toEqual(before);
    // …and the newcomer is appended rather than inserted at the top.
    const shown = Array.from(el.querySelectorAll<HTMLElement>("#by-fingerprint-panel li"));
    expect(shown.length).toBe(20);
    expect(identities(el)).not.toContain("ja4:new-arrival");
  });

  it("does not freeze the order of a section the reader never touched", () => {
    const other: RankingSectionDefinition<typeof tlsFingerprints, unknown> = {
      ...tlsRanking,
      id: "by-ip",
      path: "by_ip",
      itemKey: (item) => String((item as { scope: string }).scope),
      identity: (item) => String((item as { scope: string }).scope),
    };
    const instance = instanceOf(page(other), tlsFingerprints, "by-ip");
    const el = render(
      <Harness
        render={(ctx) => <RankingSection instance={instance} definition={other as RankingSectionDefinition<unknown, unknown>} ctx={ctx} />} />,
    );
    expect(el.querySelectorAll("#by-ip-panel li")).toHaveLength(20);
  });
});

// --- RankingSection over a REPEATING semantic key (§5.3, §19.2) ----------
//
// Telemt's `by_user` and `by_cidr` rankings group fifty ClientHello records
// under fourteen users and eight subnets, so `scope` — the honest identity
// of a row — names several rows at once. Everything below fails on a
// renderer that assumes the definition's key is unique, and none of it may
// be repaired by putting the array index into the key.
describe("RankingSection with duplicate identities (spec §5.3)", () => {
  const scopeRanking = (id: string, path: "by_user" | "by_cidr") =>
    ({
      ...tlsRanking,
      id,
      path,
      itemKey: (item: unknown) => String((item as { scope: string }).scope),
      identity: (item: unknown) => String((item as { scope: string }).scope),
    }) as RankingSectionDefinition<typeof tlsFingerprints, unknown>;

  const byUser = scopeRanking("by-user", "by_user");
  const byCidr = scopeRanking("by-cidr", "by_cidr");

  function scopeTree(
    definition: RankingSectionDefinition<typeof tlsFingerprints, unknown>,
    payload: typeof tlsFingerprints,
    strict = false,
  ): ReactNode {
    const instance = instanceOf(page(definition), payload, definition.id);
    const tree = (
      <Harness
        render={(ctx) => (
          <RankingSection
            instance={instance}
            definition={definition as RankingSectionDefinition<unknown, unknown>}
            ctx={ctx}
          />
        )}
      />
    );
    return strict ? <StrictMode>{tree}</StrictMode> : tree;
  }

  function rows(el: HTMLElement, id: string): HTMLElement[] {
    return Array.from(el.querySelectorAll<HTMLElement>(`#${id}-panel li`));
  }

  // The identity column cannot tell two namesakes apart — the score can,
  // and it is what a wrongly reconciled row gets WRONG: a Map keyed by a
  // repeating key answers with one record for all of its namesakes. The
  // digits alone, because the formatter groups thousands.
  function shownScores(el: HTMLElement, id: string): string[] {
    return rows(el, id).map((row) =>
      (row.querySelector(".text-row.font-semibold")?.textContent ?? "").replace(/\D/g, ""),
    );
  }

  function digits(value: number): string {
    return String(value);
  }

  it("draws every record once, no matter how often the identity repeats", () => {
    const el = render(scopeTree(byUser, tlsFingerprints));
    const names = identitiesIn(el, "by-user");
    // The fixture really does repeat: 20 rows, 14 distinct users.
    expect(names).toHaveLength(20);
    expect(new Set(names).size).toBe(14);
    // …and each row carries its OWN record's score, in payload order.
    expect(shownScores(el, "by-user")).toEqual(
      tlsFingerprints.by_user.slice(0, 20).map((row) => digits(row.total)),
    );
  });

  it("keys the rows without a React duplicate-key warning", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(scopeTree(byCidr, tlsFingerprints));
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("opens the record that was CLICKED, not its first namesake", () => {
    const el = render(scopeTree(byUser, tlsFingerprints));
    // Row 15 is the second `user_01` — the same identity as row 1.
    const twin = tlsFingerprints.by_user[14];
    expect(twin.scope).toBe(tlsFingerprints.by_user[0].scope);
    click(rows(el, "by-user")[14].querySelector("button")!);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain(twin.ja4);
    expect(dialog.textContent).not.toContain(tlsFingerprints.by_user[0].ja4);
  });

  it("holds the frozen order over a re-sorted payload, and re-syncs on blur", () => {
    const el = render(scopeTree(byUser, tlsFingerprints));
    const before = shownScores(el, "by-user");
    const search = el.querySelector<HTMLInputElement>('input[type="search"]')!;
    act(() => search.focus());
    // A live frame that promotes the LAST record to the top — the reorder
    // §19.2 forbids while the reader is working.
    const promoted: typeof tlsFingerprints = {
      ...tlsFingerprints,
      by_user: tlsFingerprints.by_user.map((row, i) =>
        i === tlsFingerprints.by_user.length - 1 ? { ...row, total: 999_999 } : row,
      ),
    };
    rerender(scopeTree(byUser, promoted));
    expect(identitiesIn(el, "by-user")).toHaveLength(20);
    expect(shownScores(el, "by-user")).toEqual(before);
    act(() => search.blur());
    expect(shownScores(el, "by-user")[0]).toBe("999999");
  });

  it("renders the same list under StrictMode's double pass", () => {
    const plain = render(scopeTree(byUser, tlsFingerprints));
    const expected = shownScores(plain, "by-user");
    act(() => mounted!.root.unmount());
    mounted!.container.remove();
    mounted = null;

    const strict = render(scopeTree(byUser, tlsFingerprints, true));
    expect(shownScores(strict, "by-user")).toEqual(expected);
    expect(identitiesIn(strict, "by-user")).toHaveLength(20);
  });
});

// --- CustomSection + registry (§9.8) -------------------------------------

const qualityChartSection: SectionDefinition<typeof meQuality> = {
  kind: "custom",
  id: "quality-chart",
  title: () => "RTT по интервалам",
  renderer: QUALITY_CHART_RENDERER,
  consumes: ["dc_rtt"],
  defaultExpanded: true,
  select: (q) => q.dc_rtt.map((row) => ({ label: `DC ${row.dc}`, value: row.rtt_ema_ms })),
};

function customInstance(section: SectionDefinition<typeof meQuality>): CustomSectionInstance {
  const found = resolveSections({ definition: page(section), context: meQuality }).sections.find(
    (s) => s.id === section.id,
  );
  return found as CustomSectionInstance;
}

describe("CustomSection and the renderer registry (spec §9.8)", () => {
  it("draws the reference quality chart from the registry", () => {
    const instance = customInstance(qualityChartSection);
    const el = render(<Harness render={(ctx) => <CustomSection instance={instance} ctx={ctx} />} />);
    const panel = el.querySelector("#quality-chart-panel")!;
    // One labelled bar per DC, values readable as text, plus the Sparkline.
    expect(panel.querySelectorAll('[role="listitem"]')).toHaveLength(meQuality.dc_rtt.length);
    expect(panel.textContent).toContain("DC 1");
    expect(panel.textContent).toContain("медиана");
    expect(panel.querySelector("svg")).not.toBeNull();
  });

  it("falls back to readable rows when nobody registered the id", () => {
    const instance = customInstance({ ...qualityChartSection, renderer: "not-shipped-yet" });
    const el = render(<Harness render={(ctx) => <CustomSection instance={instance} ctx={ctx} />} />);
    // The section still consumes `dc_rtt` for the completeness equation, so
    // its fields MUST stay on screen.
    expect(el.querySelector("#quality-chart-panel")!.textContent).toContain("DC 1");
  });

  it("says so when the value is not a numeric series", () => {
    const instance = customInstance({
      ...qualityChartSection,
      select: () => ({ not: "a series" }),
    });
    const el = render(<Harness render={(ctx) => <CustomSection instance={instance} ctx={ctx} />} />);
    expect(el.querySelector("#quality-chart-panel")!.textContent).toContain(
      "Нет числового ряда",
    );
  });
});
