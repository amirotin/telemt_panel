import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ru } from "../../../i18n";
import type { CustomRendererOptions } from "../model";
import type { CustomSectionInstance } from "../resolveSections";
import { QualityChart } from "./QualityChart";

// The reference custom renderer (§9.8) draws a series it deliberately does
// NOT consume, so it has no field-catalog entry to read a unit or a name
// from: whatever the header says has to come from the definition's options.

const series = [
  { label: "DC 1", value: 34 },
  { label: "DC 2", value: 189 },
  { label: "DC 3", value: 6.55 },
  { label: "DC 4", value: 186.913 },
];

function instance(value: unknown): CustomSectionInstance {
  return {
    kind: "custom",
    id: "dc_rtt_chart",
    title: () => "RTT by data center",
    defaultExpanded: true,
    path: "",
    consumed: [],
    renderer: "quality-chart",
    value,
  };
}

let mounted: { container: HTMLElement; root: Root } | null = null;

function render(options?: CustomRendererOptions): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <QualityChart instance={instance(series)} {...(options ? { options } : {})} />,
    ),
  );
  mounted = { container, root };
  return container;
}

afterEach(() => {
  if (mounted === null) return;
  const { container, root } = mounted;
  act(() => root.unmount());
  container.remove();
  mounted = null;
});

describe("QualityChart", () => {
  it("names its count and prints the median in the series' own unit", () => {
    const el = render({ unit: (s) => s.details.value.ms, countLabel: () => "DC" });
    // «4 · медиана 87,84» beside bars reading 189 was two problems in one
    // line: no unit anywhere, and a median at two decimals over columns
    // rounded to integers.
    expect(el.textContent).toContain(`4 DC · ${ru.details.chart.median}`);
    expect(el.textContent).toContain(`110 ${ru.details.value.ms}`);
    expect(el.textContent).not.toContain("109,75");
  });

  it("keeps the exact value one hover away, unit included", () => {
    const el = render({ unit: (s) => s.details.value.ms, countLabel: () => "DC" });
    const titles = Array.from(el.querySelectorAll("[title]")).map((n) => n.getAttribute("title"));
    expect(titles).toContain(`DC 4: 186,913 ${ru.details.value.ms}`);
    // …while the caption at 40 px wide stays readable.
    expect(el.textContent).toContain("187");
  });

  it("says nothing it was not given rather than inventing a unit", () => {
    const el = render();
    expect(el.textContent).toContain(`4 · ${ru.details.chart.median}`);
    expect(el.textContent).not.toContain(ru.details.value.ms);
  });
});
