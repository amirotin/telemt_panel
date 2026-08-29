import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { natStunLive10 } from "../__fixtures__";
import { natPageDefinition } from "../definitions/nat";
import { resolveSections, type CollectionSectionInstance } from "../resolveSections";
import { addressSegments } from "./addressWrap";
import { ArraySection } from "./ArraySection";
import type { DetailRenderContext } from "./context";

describe("addressSegments", () => {
  it("cuts after every DNS label and in front of the port", () => {
    expect(addressSegments("stun1.example.net:3478")).toEqual([
      "stun1.",
      "example.",
      "net",
      ":3478",
    ]);
    expect(addressSegments("198.51.100.1:443")).toEqual(["198.", "51.", "100.", "1", ":443"]);
    expect(addressSegments("[2001:db8::7]:443")).toEqual([
      "[2001",
      ":db8",
      ":",
      ":7]",
      ":443",
    ]);
  });

  it("leaves a value that already has somewhere to wrap alone", () => {
    expect(addressSegments("healthy")).toEqual(["healthy"]);
    expect(addressSegments("connect budget exceeded")).toEqual(["connect budget exceeded"]);
    expect(addressSegments("")).toEqual([""]);
  });

  it("puts the pieces back together exactly", () => {
    // The value is shown verbatim (§13.2): a break opportunity may not add,
    // drop or reorder a character.
    for (const text of ["stun1.example.net:3478", "2001:db8::7", "a.b.", ":80", "x"]) {
      expect(addressSegments(text).join("")).toBe(text);
    }
  });
});

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

const ctx: DetailRenderContext = {
  nowMs: 1_756_000_125_000,
  mode: "extended",
  lookup: {},
  expandedSections: new Set(),
  toggleSection: () => {},
  expandedRecords: new Set(),
  toggleRecord: () => {},
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

describe("a STUN server row in the narrow value column", () => {
  it("wraps inside the token and offers the boundaries as break points", () => {
    const { sections } = resolveSections({ definition: natPageDefinition, context: natStunLive10 });
    const live = sections.find((s) => s.id === "live") as CollectionSectionInstance;
    const container = render(<ArraySection instance={live} ctx={ctx} />);

    const values = [...container.querySelectorAll("div.text-row")];
    expect(values).toHaveLength(natStunLive10.servers.live.length);
    for (const value of values) {
      // `break-words` alone breaks a whitespace-free token wherever the line
      // ends; `wrap-anywhere` keeps that as the LAST resort, after the
      // explicit opportunities below.
      expect(value.className).toContain("wrap-anywhere");
      expect(value.className).not.toContain("break-words");
      expect(value.className).toContain("font-mono");
      expect(value.querySelectorAll("wbr").length).toBeGreaterThan(0);
      // …and the address itself is untouched: `<wbr>` contributes no text.
      expect(value.textContent).toMatch(/^\S+\.\S+:\d+$/);
    }
  });
});
