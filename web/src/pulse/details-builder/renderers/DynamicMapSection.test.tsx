import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { zeroAll } from "../__fixtures__";
import type { DetailPageDefinition } from "../model";
import { resolveSections, type DynamicMapSectionInstance } from "../resolveSections";
import { DynamicMapSection } from "./DynamicMapSection";
import type { DetailRenderContext } from "./context";

const NOW = 1_756_000_125_000;

// A small hand-made counters map whose keys land in DIFFERENT families, so
// a search can be shown to read the description and not only the key.
// zeroAll's own keys are all `*_total`, which cannot separate the two.
const mixed = {
  core: {
    connections_total: 0,
    connections_active_count: 2088,
    handshake_ok_total: 23627,
    request_latency_ms: 42,
    ingress_bytes: 6831,
    read_errors_total: 0,
  },
  pool: {
    pool_alive_count: 12,
    pool_dead_count: 0,
  },
};

const mixedDefinition: DetailPageDefinition<typeof mixed, typeof mixed> = {
  id: "test.mixed",
  title: () => "All counters",
  sources: [{ id: "stats", required: true }],
  sections: [
    {
      kind: "dynamicMap",
      id: "all",
      title: () => "All counters",
      path: "",
      defaultExpanded: true,
      supportsDelta: true,
      groups: [
        { id: "core", title: () => "Core", path: "core" },
        { id: "pool", title: () => "Pool", path: "pool" },
      ],
    },
  ],
};

const definition: DetailPageDefinition<typeof zeroAll, typeof zeroAll> = {
  id: "test.counters",
  title: () => "Counters",
  sources: [{ id: "stats", required: true }],
  sections: [
    {
      kind: "dynamicMap",
      id: "all",
      title: () => "All counters",
      path: "",
      defaultExpanded: true,
      supportsDelta: true,
      groups: [
        { id: "core", title: () => "Core", path: "core" },
        { id: "pool", title: () => "Pool", path: "pool" },
      ],
    },
  ],
};

function instance(): DynamicMapSectionInstance {
  const resolved = resolveSections({ definition, context: zeroAll });
  return resolved.sections.find((s) => s.id === "all") as DynamicMapSectionInstance;
}

function mixedInstance(): DynamicMapSectionInstance {
  const resolved = resolveSections({ definition: mixedDefinition, context: mixed });
  return resolved.sections.find((s) => s.id === "all") as DynamicMapSectionInstance;
}

function toggled(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

let mounted: { container: HTMLElement; root: Root } | null = null;

function Harness({
  deltas,
  deltaSinceOpen,
  onResetDelta,
  production,
}: {
  deltas?: Record<string, number>;
  deltaSinceOpen?: Record<string, number>;
  onResetDelta?: () => void;
  production?: boolean;
}) {
  const [sections, setSections] = useState<ReadonlySet<string>>(new Set());
  const [records, setRecords] = useState<ReadonlySet<string>>(new Set());
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
    openSurfaceKey: undefined,
    openSurface: () => {},
    closeSurface: () => {},
  };
  return (
    <DynamicMapSection
      instance={production ? instance() : mixedInstance()}
      ctx={ctx}
      {...(deltas !== undefined ? { deltas } : {})}
      {...(deltaSinceOpen !== undefined ? { deltaSinceOpen } : {})}
      {...(onResetDelta !== undefined ? { onResetDelta } : {})}
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
});

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

function searchBox(el: HTMLElement): HTMLInputElement {
  return el.querySelector<HTMLInputElement>('input[type="search"]')!;
}

function toggle(el: HTMLElement): HTMLButtonElement {
  return el.querySelector<HTMLButtonElement>('button[role="switch"]')!;
}

function click(node: Element): void {
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("DynamicMapSection (spec §9.7, §11.2)", () => {
  it("shows every key verbatim, grouped, with its counters-family description", () => {
    const el = render(<Harness production />);
    const text = el.textContent ?? "";
    expect(text).toContain("Core");
    // The production-size fixture's own keys, printed as Telemt spells
    // them — §11.2 forbids translating or renaming a map key.
    expect(text).toContain("core_0_total");
    expect(text).toContain("Накопительный счётчик");
    // A nested array inside a counters map stays an array block (§11.2).
    expect(text).toContain("connections_bad_by_class[]");
  });

  it("searches over the KEY", () => {
    const el = render(<Harness />);
    type(searchBox(el), "handshake");
    const text = el.textContent ?? "";
    expect(text).toContain("handshake_ok_total");
    expect(text).not.toContain("connections_total");
  });

  it("searches over the DESCRIPTION too, not only the key", () => {
    const el = render(<Harness />);
    // No counter key contains "миллисекунд"; the milliseconds family
    // description does, so a match proves the description is searched.
    type(searchBox(el), "миллисекунд");
    const text = el.textContent ?? "";
    expect(text).toContain("request_latency_ms");
    expect(text).not.toContain("connections_total");
  });

  it("says so when nothing matches instead of showing an empty card", () => {
    const el = render(<Harness />);
    type(searchBox(el), "нет-такого-счётчика");
    expect(el.textContent).toContain("Ничего не найдено по запросу.");
  });

  it("hides zero counters behind the non-zero filter and keeps the real values", () => {
    const el = render(<Harness />);
    // The map carries both: connections_total is 0, the active gauge is not.
    expect(el.textContent).toContain("connections_total");
    click(toggle(el));
    const text = el.textContent ?? "";
    expect(text).not.toContain("connections_total");
    expect(text).not.toContain("read_errors_total");
    expect(text).toContain("connections_active_count");
  });

  it("offers a delta control and says honestly when there is nothing to compare", () => {
    const el = render(<Harness />);
    const deltaChip = Array.from(el.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Изменение за секунду"),
    )!;
    click(deltaChip);
    expect(el.textContent).toContain("Изменение появится после второго ответа.");
  });

  it("renders a supplied delta beside the value", () => {
    const el = render(<Harness deltas={{ "core.connections_active_count": 13 }} />);
    const deltaChip = Array.from(el.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Изменение за секунду"),
    )!;
    click(deltaChip);
    expect(el.textContent).toContain("+13/с");
    expect(el.textContent).not.toContain("Изменение появится после второго ответа.");
  });
});

// Ruling R4's second column: the change since the reader opened the page,
// with a control that moves the baseline. The two views are exclusive —
// a row can carry one number legibly, not two.
describe("DynamicMapSection deltas (ruling R4)", () => {
  const chip = (el: HTMLElement, text: string) =>
    Array.from(el.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes(text),
    ) as HTMLButtonElement;

  it("offers both delta views and shows one at a time", () => {
    const el = render(
      <Harness
        deltas={{ "core.connections_active_count": 13 }}
        deltaSinceOpen={{ "core.connections_active_count": 420 }}
      />,
    );
    click(chip(el, "Изменение за секунду"));
    expect(el.textContent).toContain("+13/с");
    expect(el.textContent).not.toContain("+420");

    click(chip(el, "С момента открытия"));
    // The since-open number is a TOTAL, so it carries no "/с" suffix.
    expect(el.textContent).toContain("+420");
    expect(el.textContent).not.toContain("+13/с");
  });

  it("turns a view off when its own chip is pressed again", () => {
    const el = render(<Harness deltas={{ "core.connections_active_count": 13 }} />);
    click(chip(el, "Изменение за секунду"));
    expect(el.textContent).toContain("+13/с");
    click(chip(el, "Изменение за секунду"));
    expect(el.textContent).not.toContain("+13/с");
  });

  it("says honestly that the since-open column has nothing yet", () => {
    const el = render(<Harness deltas={{ "core.connections_active_count": 13 }} />);
    click(chip(el, "С момента открытия"));
    expect(el.textContent).toContain("Изменение появится после второго ответа.");
  });

  it("offers the reset control only while the since-open view is on", () => {
    let resets = 0;
    const el = render(
      <Harness
        deltaSinceOpen={{ "core.connections_active_count": 420 }}
        onResetDelta={() => {
          resets += 1;
        }}
      />,
    );
    expect(chip(el, "Сбросить отсчёт")).toBeUndefined();
    click(chip(el, "С момента открытия"));
    click(chip(el, "Сбросить отсчёт"));
    expect(resets).toBe(1);
  });
});
