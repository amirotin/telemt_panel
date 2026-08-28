import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { resetLocaleForTests, setLocalePreference } from "../../i18n";
import { SummaryGrid } from "./SummaryGrid";
import type { SummaryMetricDefinition } from "./model";

// The summary strip is the ONE surface that names a field in human words:
// the renders show "Coverage" / "Покрытие", while the §8.1 rows below keep
// showing Telemt's own `coverage_pct`. These tests pin both halves of that
// rule, including the fallback for a field the catalog has never seen.

const NOW = 1_756_000_125_000;

interface Ctx {
  coverage_pct: number;
  dropped_total: number;
}

const context: Ctx = { coverage_pct: 92.5, dropped_total: 3 };

let mounted: { container: HTMLElement; root: Root } | null = null;

function render(metrics: SummaryMetricDefinition<Ctx>[]): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <SummaryGrid metrics={metrics} context={context} mode="extended" nowMs={NOW} />,
    ),
  );
  mounted = { container, root };
  return container;
}

afterEach(() => {
  if (mounted) {
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
  act(() => resetLocaleForTests());
});

describe("SummaryGrid tile names (spec §6, §8)", () => {
  it("names an unlabelled metric from the field catalog, in the reader's language", () => {
    const metrics: SummaryMetricDefinition<Ctx>[] = [
      { id: "coverage", path: "coverage_pct", value: (c) => c.coverage_pct, unit: "percent" },
    ];

    act(() => setLocalePreference("ru"));
    const ru = render(metrics);
    expect(ru.textContent).toContain("Покрытие");
    expect(ru.textContent).not.toContain("coverage_pct");

    act(() => mounted!.root.unmount());
    mounted!.container.remove();
    mounted = null;

    act(() => setLocalePreference("en"));
    const en = render(metrics);
    expect(en.textContent).toContain("Coverage");
    expect(en.textContent).not.toContain("coverage_pct");
  });

  it("takes the path from the metric id when there is no explicit path", () => {
    act(() => setLocalePreference("ru"));
    const el = render([{ id: "coverage_pct", value: (c) => c.coverage_pct, unit: "percent" }]);
    expect(el.textContent).toContain("Покрытие");
  });

  it("falls back to the raw key only when the catalog describes nothing", () => {
    act(() => setLocalePreference("ru"));
    const el = render([
      { id: "dropped", path: "dropped_total", value: (c) => c.dropped_total, format: "integer" },
    ]);
    expect(el.textContent).toContain("dropped_total");
  });

  it("still honours an explicit label over the catalog", () => {
    act(() => setLocalePreference("ru"));
    const el = render([
      {
        id: "coverage",
        path: "coverage_pct",
        label: () => "Своё название",
        value: (c) => c.coverage_pct,
        unit: "percent",
      },
    ]);
    expect(el.textContent).toContain("Своё название");
    expect(el.textContent).not.toContain("Покрытие");
  });
});
