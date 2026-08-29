import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SectionTabs } from "./SectionTabs";

// ME is the first page with five tabs, which is what exposed the strip's
// two gaps: a tab restored FROM THE ROUTE was never scrolled into view, and
// the only sign there was more to the right was a word clipped by a glyph.

const TABS = [
  { id: "overview", label: "Обзор" },
  { id: "writers", label: "Писатели" },
  { id: "quality", label: "Качество" },
  { id: "init", label: "Инициализация" },
  { id: "runtime", label: "Рантайм" },
];

let mounted: { container: HTMLElement; root: Root } | null = null;

// A 360 px strip whose five tabs need 720: jsdom lays nothing out, so the
// geometry the component reads is stubbed on the elements it reads it from.
function layout(list: HTMLElement): void {
  Object.defineProperty(list, "clientWidth", { value: 360, configurable: true });
  Object.defineProperty(list, "scrollWidth", { value: 720, configurable: true });
  Object.defineProperty(list, "offsetLeft", { value: 0, configurable: true });
  list.querySelectorAll<HTMLElement>('[role="tab"]').forEach((tab, i) => {
    Object.defineProperty(tab, "offsetLeft", { value: i * 144, configurable: true });
    Object.defineProperty(tab, "offsetWidth", { value: 140, configurable: true });
  });
}

function render(activeId: string): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <SectionTabs
        tabs={TABS}
        activeId={activeId}
        onSelect={() => {}}
        panelId="panel"
        label="Разделы"
      />,
    ),
  );
  mounted = { container, root };
  return container;
}

function rerender(container: HTMLElement, activeId: string): void {
  act(() =>
    mounted?.root.render(
      <SectionTabs
        tabs={TABS}
        activeId={activeId}
        onSelect={() => {}}
        panelId="panel"
        label="Разделы"
      />,
    ),
  );
  void container;
}

afterEach(() => {
  if (mounted === null) return;
  const { container, root } = mounted;
  act(() => root.unmount());
  container.remove();
  mounted = null;
});

describe("SectionTabs", () => {
  it("brings a tab restored from the route into view without scrolling the page", () => {
    const el = render("overview");
    const list = el.querySelector<HTMLElement>('[role="tablist"]')!;
    layout(list);
    const before = document.documentElement.scrollTop;

    rerender(el, "runtime");
    // The fifth tab spans 576…716, so the strip has to end at 716.
    expect(list.scrollLeft).toBe(716 - 360);
    expect(document.documentElement.scrollTop).toBe(before);

    rerender(el, "overview");
    expect(list.scrollLeft).toBe(0);
  });

  it("shows a fade on the side that is actually clipped, and none otherwise", () => {
    const el = render("overview");
    const list = el.querySelector<HTMLElement>('[role="tablist"]')!;
    layout(list);
    const fades = () => el.querySelectorAll('[aria-hidden="true"]').length;

    act(() => list.dispatchEvent(new Event("scroll")));
    // At the left edge only the right-hand side is clipped.
    expect(fades()).toBe(1);

    list.scrollLeft = 200;
    act(() => list.dispatchEvent(new Event("scroll")));
    expect(fades()).toBe(2);

    // A strip that fits carries no affordance at all.
    Object.defineProperty(list, "scrollWidth", { value: 360, configurable: true });
    list.scrollLeft = 0;
    act(() => list.dispatchEvent(new Event("scroll")));
    expect(fades()).toBe(0);
  });
});

describe("tab count badges (§10, up-sec-desktop.png)", () => {
  function renderCounts(tabs: { id: string; label: string; count?: number }[]): HTMLElement {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <SectionTabs
          tabs={tabs}
          activeId={tabs[0]?.id}
          onSelect={() => {}}
          panelId="panel"
          label="Разделы"
        />,
      ),
    );
    mounted = { container, root };
    return container;
  }

  it("puts the size beside the label, never instead of it", () => {
    const el = renderCounts([
      { id: "posture", label: "Посадка" },
      { id: "by_ip", label: "По IP", count: 50 },
    ]);
    const tabs = Array.from(el.querySelectorAll<HTMLElement>('[role="tab"]'));
    // The tab with no count is a bare label — no stray "0".
    expect(tabs[0].textContent).toBe("Посадка");
    // The one with a count keeps its name and gains the figure.
    expect(tabs[1].textContent).toContain("По IP");
    expect(tabs[1].textContent).toContain("50");
  });

  it("draws no badge for a scope that has not answered", () => {
    const el = renderCounts([{ id: "by_user", label: "По пользователю" }]);
    expect(el.querySelector<HTMLElement>('[role="tab"]')!.textContent).toBe("По пользователю");
  });

  it("does draw a zero for a scope that answered empty", () => {
    // §14 keeps "no answer" and "answered with nothing" apart, and a badge
    // is one of the few places the difference is visible at a glance.
    const el = renderCounts([{ id: "by_cidr", label: "По подсети", count: 0 }]);
    expect(el.querySelector<HTMLElement>('[role="tab"]')!.textContent).toContain("0");
  });
});
