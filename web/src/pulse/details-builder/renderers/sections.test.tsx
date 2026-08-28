import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { dcs, meQuality, zeroAll } from "../__fixtures__";
import type { DetailPageDefinition } from "../model";
import { resolveSections, type ScalarSectionInstance, type SectionInstance } from "../resolveSections";
import { ScalarSection } from "./ScalarSection";
import { ArraySection } from "./ArraySection";
import { UnknownFieldsSection } from "./UnknownFieldsSection";
import { SectionList } from "./SectionList";
import type { DetailRenderContext } from "./context";

// Fixed clock: nothing here renders a relative age, but FormatContext
// requires one and a real Date.now() would make a formatter test
// non-deterministic by construction.
const NOW = 1_756_000_125_000;

function toggled(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

// Harness holds the slice of PageState the renderers read, so a test can
// click an accordion and see the result without a router or a reducer.
function Harness({ render }: { render: (ctx: DetailRenderContext) => ReactNode }) {
  const [sections, setSections] = useState<ReadonlySet<string>>(new Set());
  const [records, setRecords] = useState<ReadonlySet<string>>(new Set());
  const [limits, setLimits] = useState<Record<string, number>>({});
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
    openSurfaceKey: undefined,
    openSurface: () => {},
    closeSurface: () => {},
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

const dc = dcs.dcs[0];

function resolve<T>(definition: DetailPageDefinition<T, T>, context: T): SectionInstance[] {
  const result = resolveSections({ definition, context });
  return result.unknownFields === null
    ? result.sections
    : [...result.sections, result.unknownFields];
}

function byId(sections: SectionInstance[], id: string): SectionInstance {
  const found = sections.find((s) => s.id === id);
  if (!found) throw new Error(`no section ${id}`);
  return found;
}

// --- ScalarSection --------------------------------------------------------

const dcDefinition: DetailPageDefinition<typeof dc, typeof dc> = {
  id: "test.dc",
  title: () => "DC",
  sources: [{ id: "upstreams", required: true }],
  sections: [
    {
      kind: "scalars",
      id: "routing",
      title: () => "Routing",
      defaultExpanded: true,
      // `endpoints` is an ARRAY bound to a scalar section on purpose: §9.1
      // says the resolver extracts it rather than letting it reach a row.
      fields: [{ path: "dc" }, { path: "available_pct" }, { path: "endpoints" }],
    },
    { kind: "array", id: "endpoints", title: () => "endpoints[]", path: "endpoints" },
    {
      kind: "array",
      id: "endpoint_writers",
      title: () => "endpoint_writers[]",
      path: "endpoint_writers",
    },
  ],
  unknownFields: { minMode: "extended" },
};

describe("ScalarSection (spec §8.1, §9.1)", () => {
  it("renders a name, its catalog description and the value for every leaf", () => {
    const sections = resolve(dcDefinition, dc);
    const el = render(
      <Harness
        render={(ctx) => (
          <ScalarSection instance={byId(sections, "routing") as ScalarSectionInstance} ctx={ctx} />
        )}
      />,
    );
    const text = el.textContent ?? "";
    expect(text).toContain("available_pct");
    expect(text).toContain("Доля пригодных адресов");
    expect(text).toContain("100");
  });

  it("never puts an array in a scalar row — the resolver extracted it (§12.7)", () => {
    const sections = resolve(dcDefinition, dc);
    const scalars = byId(sections, "routing") as ScalarSectionInstance;
    expect(scalars.rows.map((r) => r.path)).not.toContain("endpoints");
  });

  it("renders a structured value as a sentence, never as a comma-joined list", () => {
    // The one case the resolver cannot prevent: a hand-built instance. The
    // row must still refuse to print "a, b, c" or "3 items".
    const rogue: ScalarSectionInstance = {
      kind: "scalars",
      id: "rogue",
      title: () => "Rogue",
      defaultExpanded: true,
      path: "",
      consumed: [],
      rows: [
        { path: "endpoints", value: dc.endpoints as never, present: true },
        { path: "endpoint_writers", value: dc.endpoint_writers as never, present: true },
      ],
    };
    const el = render(<Harness render={(ctx) => <ScalarSection instance={rogue} ctx={ctx} />} />);
    const text = el.textContent ?? "";
    expect(text).toContain("составное значение");
    expect(text).not.toContain(dc.endpoints.join(", "));
    expect(text).not.toMatch(/\d+\s*items/i);
  });
});

// --- accordion contract ---------------------------------------------------

describe("section accordion (spec §21)", () => {
  it("exposes aria-expanded and aria-controls, and hides the panel while collapsed", () => {
    // The 10-endpoint DC: above §10.5's threshold, so the section starts
    // collapsed and the accordion contract is observable in both states.
    const sections = resolve(dcDefinition, dcs.dcs[11]);
    const el = render(
      <Harness
        render={(ctx) => <ArraySection instance={byId(sections, "endpoints") as never} ctx={ctx} />}
      />,
    );
    const button = el.querySelector("button[aria-expanded]")!;
    const panelId = button.getAttribute("aria-controls")!;
    const panel = el.querySelector(`#${CSS.escape(panelId)}`)!;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(panel.hasAttribute("hidden")).toBe(true);

    click(button);
    expect(el.querySelector("button[aria-expanded]")!.getAttribute("aria-expanded")).toBe("true");
    expect(el.querySelector(`#${CSS.escape(panelId)}`)!.hasAttribute("hidden")).toBe(false);
  });

  it("has a 44px tap target on the header (§16.4)", () => {
    const sections = resolve(dcDefinition, dc);
    const el = render(
      <Harness render={(ctx) => <ArraySection instance={byId(sections, "endpoints") as never} ctx={ctx} />} />,
    );
    expect(el.querySelector("button[aria-expanded]")!.className).toContain("tap-target");
  });
});

// --- ArraySection ---------------------------------------------------------

describe("ArraySection (spec §10)", () => {
  it("gives a primitive array one row per element, never a comma-joined string", () => {
    const many = dcs.dcs[11];
    const sections = resolve(dcDefinition, many);
    const el = render(
      <Harness render={(ctx) => <ArraySection instance={byId(sections, "endpoints") as never} ctx={ctx} />} />,
    );
    // The section starts collapsed above the §10.5 threshold; open it.
    const button = el.querySelector("button[aria-expanded]")!;
    if (button.getAttribute("aria-expanded") === "false") click(button);
    const text = el.textContent ?? "";
    for (const endpoint of many.endpoints) expect(text).toContain(endpoint);
    expect(text).not.toContain(many.endpoints.join(", "));
    expect(text).not.toMatch(/\d+\s*items/i);
  });

  it("distinguishes an empty array from an absent field (§10.3)", () => {
    const emptyDc = { ...dc, endpoints: [] };
    const absentDc = { ...dc } as Record<string, unknown>;
    delete absentDc["endpoints"];

    const emptySections = resolve(dcDefinition, emptyDc);
    const el = render(
      <Harness
        render={(ctx) => <ArraySection instance={byId(emptySections, "endpoints") as never} ctx={ctx} />}
      />,
    );
    expect(el.textContent).toContain("Нет элементов в текущем снимке");

    act(() => mounted!.root.unmount());
    mounted!.container.remove();
    mounted = null;

    const absentSections = resolve(dcDefinition, absentDc as unknown as typeof dc);
    const el2 = render(
      <Harness
        render={(ctx) => <ArraySection instance={byId(absentSections, "endpoints") as never} ctx={ctx} />}
      />,
    );
    expect(el2.textContent).toContain("Поле не пришло в этом ответе");
    expect(el2.textContent).not.toContain("Нет элементов в текущем снимке");
  });

  it("renders records as cards whose fields are described rows, not index paths", () => {
    const sections = resolve(dcDefinition, dc);
    const el = render(
      <Harness
        render={(ctx) => <ArraySection instance={byId(sections, "endpoint_writers") as never} ctx={ctx} />}
      />,
    );
    const button = el.querySelector("button[aria-expanded]")!;
    if (button.getAttribute("aria-expanded") === "false") click(button);
    const text = el.textContent ?? "";
    expect(text).toContain("endpoint_writers[0]");
    expect(text).toContain("active_writers");
    // Never the flattened "endpoint writers[0].active writers" shape.
    expect(text).not.toContain("endpoint_writers[0].active_writers");
  });

  it("does not flatten a nested array into a scalar row (§10.4)", () => {
    const nested = { rows: [{ name: "a", tags: ["x", "y", "z"] }] };
    const definition: DetailPageDefinition<typeof nested, typeof nested> = {
      id: "test.nested",
      title: () => "Nested",
      sources: [{ id: "s", required: true }],
      sections: [{ kind: "array", id: "rows", title: () => "rows[]", path: "rows" }],
    };
    const sections = resolve(definition, nested);
    const el = render(
      <Harness render={(ctx) => <ArraySection instance={byId(sections, "rows") as never} ctx={ctx} />} />,
    );
    const text = el.textContent ?? "";
    expect(text).toContain("tags[]");
    expect(text).not.toContain("x, y, z");
    expect(text).toContain("x");
    expect(text).toContain("z");
  });
});

// --- UnknownFieldsSection -------------------------------------------------

const bareDefinition: DetailPageDefinition<typeof meQuality, typeof meQuality> = {
  id: "test.bare",
  title: () => "Bare",
  sources: [{ id: "runtime", required: true }],
  sections: [],
  unknownFields: { minMode: "extended", rawJson: true },
};

describe("UnknownFieldsSection (spec §11.3, §24; ruling R2)", () => {
  it("is closed by default", () => {
    const sections = resolve(bareDefinition, meQuality);
    const tail = byId(sections, "unknown-fields");
    const el = render(
      <Harness render={(ctx) => <UnknownFieldsSection instance={tail as never} ctx={ctx} />} />,
    );
    expect(el.querySelector("button[aria-expanded]")!.getAttribute("aria-expanded")).toBe("false");
    expect(tail.defaultExpanded).toBe(false);
  });

  it("keeps containers as containers once opened — no flattened dump", () => {
    const sections = resolve(bareDefinition, meQuality);
    const el = render(
      <Harness
        render={(ctx) => <UnknownFieldsSection instance={byId(sections, "unknown-fields") as never} ctx={ctx} />}
      />,
    );
    click(el.querySelector("button[aria-expanded]")!);
    const text = el.textContent ?? "";
    expect(text).toContain("family_states[]");
    expect(text).toContain("dc_rtt[]");
    expect(text).not.toContain("family_states[0].family");
  });

  it("is hidden below extended display mode (ruling R2)", () => {
    const sections = resolve(bareDefinition, meQuality);
    const basic = render(
      <Harness
        render={(ctx) => <SectionList sections={sections} ctx={{ ...ctx, mode: "basic" }} />}
      />,
    );
    expect(basic.textContent).not.toContain("Прочие поля");

    act(() => mounted!.root.unmount());
    mounted!.container.remove();
    mounted = null;

    const extended = render(<Harness render={(ctx) => <SectionList sections={sections} ctx={ctx} />} />);
    expect(extended.textContent).toContain("Прочие поля");
  });
});

// --- SectionList visibility ----------------------------------------------

describe("SectionList applies the ONE display-mode predicate", () => {
  it("drops a section whose minMode the current mode does not reach", () => {
    const definition: DetailPageDefinition<typeof zeroAll, typeof zeroAll> = {
      id: "test.modes",
      title: () => "Modes",
      sources: [{ id: "stats", required: true }],
      sections: [
        {
          kind: "dynamicMap",
          id: "core",
          title: () => "Core counters",
          path: "core",
          minMode: "extended",
        },
      ],
      unknownFields: { minMode: "extended" },
    };
    const sections = resolve(definition, zeroAll);
    const basic = render(
      <Harness
        render={(ctx) => <SectionList sections={sections} ctx={{ ...ctx, mode: "basic" }} />}
      />,
    );
    expect(basic.textContent).not.toContain("Core counters");

    act(() => mounted!.root.unmount());
    mounted!.container.remove();
    mounted = null;

    const extended = render(<Harness render={(ctx) => <SectionList sections={sections} ctx={ctx} />} />);
    expect(extended.textContent).toContain("Core counters");
  });
});
