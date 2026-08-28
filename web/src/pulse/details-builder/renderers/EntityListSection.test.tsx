import { act, useMemo, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { meWriters } from "../__fixtures__";
import type { DetailPageDefinition, EntityListSectionDefinition } from "../model";
import { resolveSections, type CollectionSectionInstance } from "../resolveSections";
import { EntityListSection } from "./EntityListSection";
import type { DetailRenderContext } from "./context";

const NOW = 1_756_000_125_000;

interface Writer {
  writer_id: number;
  dc: number;
  state: string;
  rtt_ema_ms: number;
}

const writerSection: EntityListSectionDefinition<unknown, Writer> = {
  kind: "entityList",
  id: "writers",
  title: () => "writers[]",
  path: "writers",
  // The SEMANTIC key of §5.3 — the writer's own id, never the array index.
  itemKey: (item) => `writer:${item.writer_id}`,
  identity: (item) => `writer #${item.writer_id}`,
  status: (item) => `DC ${item.dc} · ${item.state}`,
  highlights: ["rtt_ema_ms"],
};

const definition: DetailPageDefinition<typeof meWriters, typeof meWriters> = {
  id: "test.writers",
  title: () => "Writers",
  sources: [{ id: "stats", required: true }],
  sections: [writerSection as never],
};

function instanceFor(payload: typeof meWriters): CollectionSectionInstance {
  const resolved = resolveSections({ definition, context: payload });
  return resolved.sections.find((s) => s.id === "writers") as CollectionSectionInstance;
}

function toggled(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

let mounted: { container: HTMLElement; root: Root } | null = null;
// The surface key the harness last opened. Written from the ctx callbacks
// (never during render, which react-hooks/globals rightly forbids).
const opened: { key: string | undefined } = { key: undefined };

function Harness({ payload, search }: { payload: typeof meWriters; search?: string }) {
  const instance = useMemo(() => instanceFor(payload), [payload]);
  const [sections, setSections] = useState<ReadonlySet<string>>(new Set());
  const [records, setRecords] = useState<ReadonlySet<string>>(new Set());
  const [surface, setSurface] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState(search ?? "");
  const ctx: DetailRenderContext = {
    nowMs: NOW,
    mode: "extended",
    lookup: {},
    expandedSections: sections,
    toggleSection: (id) => setSections((prev) => toggled(prev, id)),
    expandedRecords: records,
    toggleRecord: (id) => setRecords((prev) => toggled(prev, id)),
    visibleLimit: (_id, initial) => initial,
    revealMore: () => {},
    filters: {},
    setFilter: () => {},
    sort: undefined,
    setSort: () => {},
    openSurfaceKey: surface,
    openSurface: (key) => {
      opened.key = key;
      setSurface(key);
    },
    closeSurface: () => {
      opened.key = undefined;
      setSurface(undefined);
    },
  };
  return (
    <EntityListSection
      instance={instance}
      definition={writerSection as EntityListSectionDefinition<unknown, unknown>}
      ctx={ctx}
      searchQuery={query}
      onSearchChange={setQuery}
    />
  );
}

function render(node: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted = { container, root };
  return container;
}

afterEach(() => {
  if (mounted) {
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
  opened.key = undefined;
});

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function entityRows(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button[aria-label]")).filter(
    (b) => (b.getAttribute("aria-label") ?? "").startsWith("Открыть детали"),
  );
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

describe("EntityListSection (spec §9.3, §17)", () => {
  it("renders one compact row per entity with identity, status and a highlight", () => {
    const el = render(<Harness payload={meWriters} />);
    const rows = entityRows(el);
    expect(rows.length).toBeGreaterThan(0);
    const first = rows[0];
    expect(first.textContent).toContain("writer #");
    expect(first.textContent).toContain("DC ");
    // The row does NOT carry the whole record — that is the surface's job.
    expect(first.textContent).not.toContain("generation");
  });

  it("marks every row as a member of the roving group (§21)", () => {
    const el = render(<Harness payload={meWriters} />);
    const rows = entityRows(el);
    // useRovingFocus.onKeyDown finds the rows by this attribute alone, so a
    // row that lost it would keep its tab stop and quietly stop responding
    // to the arrow keys.
    expect(el.querySelectorAll("[data-roving-item]")).toHaveLength(rows.length);
    expect(rows.filter((r) => r.tabIndex === 0)).toHaveLength(1);
  });

  it("opens the adaptive surface on the row and shows the remaining fields", () => {
    const el = render(<Harness payload={meWriters} />);
    expect(dialog()).toBeNull();
    click(entityRows(el)[0]);
    const surface = dialog()!;
    expect(surface.getAttribute("aria-modal")).toBe("true");
    expect(surface.textContent).toContain("writer_id");
    expect(surface.textContent).toContain("generation");
  });

  it("returns focus to the row that opened it when it closes (§17)", () => {
    const el = render(<Harness payload={meWriters} />);
    const row = entityRows(el)[0];
    row.focus();
    click(row);
    expect(document.activeElement).not.toBe(row);

    const close = dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Закрыть"]')!;
    click(close);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("closes on Escape", () => {
    const el = render(<Harness payload={meWriters} />);
    click(entityRows(el)[0]);
    expect(dialog()).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(dialog()).toBeNull();
  });

  it("keeps the open surface on the SAME entity when the collection reorders (§19.2)", () => {
    const el = render(<Harness payload={meWriters} />);
    const second = entityRows(el)[1];
    const identity = (second.getAttribute("aria-label") ?? "").replace("Открыть детали: ", "");
    click(second);
    const keyBefore = opened.key;
    expect(dialog()!.textContent).toContain(identity);

    // A realtime frame that reverses the order must not move the surface
    // onto a different writer: the key is semantic, not positional.
    const reversed = { ...meWriters, writers: [...meWriters.writers].reverse() };
    act(() => mounted!.root.render(<Harness payload={reversed} />));
    expect(opened.key).toBe(keyBefore);
    expect(dialog()!.textContent).toContain(identity);
  });

  it("filters rows by the page search when the collection is big enough to need one", () => {
    expect(instanceFor(meWriters).searchRequired).toBe(true);
    const el = render(<Harness payload={meWriters} search="writer #1001" />);
    const rows = entityRows(el);
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("writer #1001");
  });
});
