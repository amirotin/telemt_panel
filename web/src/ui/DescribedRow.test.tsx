import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { DescribedRow } from "./DescribedRow";
import { KVRow } from "./KVRow";

// DescribedRow is the spec's §8.1 row and the layout every Details page is
// built out of, so its contract is worth pinning: two columns and never a
// third, a description that is always visible, and a value that wraps
// instead of being cut.

let mounted: { container: HTMLElement; root: Root } | null = null;

function render(node: React.ReactElement): HTMLElement {
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

describe("DescribedRow (spec §8.1)", () => {
  it("keeps the name and its description in ONE left block, value on the right", () => {
    const el = render(
      <DescribedRow
        name="available_pct"
        description="Доля доступных endpoint от общего числа настроенных."
        value="100.0%"
      />,
    );
    const row = el.firstElementChild!;
    // Two children: the left block and the value block. A separate
    // description column is forbidden.
    expect(row.children).toHaveLength(2);
    const left = row.children[0];
    expect(left.textContent).toContain("available_pct");
    expect(left.textContent).toContain("Доля доступных endpoint");
    expect(row.children[1].textContent).toContain("100.0%");
  });

  it("shows the description permanently, not only as a tooltip", () => {
    const el = render(<DescribedRow name="rtt_ms" description="Оценка RTT." value="4 ms" />);
    const description = el.querySelector("p");
    expect(description?.textContent).toBe("Оценка RTT.");
    expect(description?.hasAttribute("hidden")).toBe(false);
  });

  it("wraps a long value instead of truncating it (§13.2)", () => {
    const el = render(
      <DescribedRow
        name="ja4_raw"
        value={"t13d1516h2_" + "a".repeat(64)}
        monospaceValue
      />,
    );
    const value = el.firstElementChild!.children[1].firstElementChild!;
    expect(value.className).toContain("break-words");
    expect(value.className).not.toContain("truncate");
  });

  it("caps the value column so a long value cannot widen the viewport", () => {
    const el = render(<DescribedRow name="endpoint" value="198.51.100.10:8443" />);
    expect(el.firstElementChild!.children[1].className).toContain("max-w-[42%]");
  });

  it("applies tabular numerals only when the value is a rendered number", () => {
    const numeric = render(<DescribedRow name="load" value="38" numeric />);
    expect(numeric.firstElementChild!.children[1].firstElementChild!.className).toContain(
      "tabular-nums",
    );
    act(() => mounted!.root.unmount());
    mounted!.container.remove();
    mounted = null;
    const text = render(<DescribedRow name="state" value="draining" />);
    expect(text.firstElementChild!.children[1].firstElementChild!.className).not.toContain(
      "tabular-nums",
    );
  });

  it("renders an absence quietly instead of as a value", () => {
    const el = render(<DescribedRow name="rtt_ms" value="замера ещё не было" absent />);
    const value = el.firstElementChild!.children[1].firstElementChild!;
    expect(value.className).toContain("text-text-faint");
    expect(value.className).not.toContain("font-semibold");
  });

  it("omits the description block entirely when there is none", () => {
    const el = render(<DescribedRow name="dc" value="1" />);
    expect(el.querySelector("p")).toBeNull();
  });
});

describe("KVRow stays a thin wrapper (compatibility)", () => {
  it("renders the label and value as one DescribedRow with no description", () => {
    const el = render(<KVRow label="Порт" value="8443" />);
    const row = el.firstElementChild!;
    expect(row.children).toHaveLength(2);
    expect(row.children[0].textContent).toBe("Порт");
    expect(row.children[1].textContent).toContain("8443");
    expect(el.querySelector("p")).toBeNull();
  });

  it("keeps the pre-existing value weight — no emphasis on a labelled row", () => {
    const el = render(<KVRow label="Порт" value="8443" />);
    expect(el.firstElementChild!.children[1].firstElementChild!.className).not.toContain(
      "font-semibold",
    );
  });

  it("still emphasizes a Details field row, and lets a caller override either way", () => {
    const field = render(<DescribedRow name="rtt_ms" value="4 ms" />);
    expect(field.firstElementChild!.children[1].firstElementChild!.className).toContain(
      "font-semibold",
    );
    act(() => mounted!.root.unmount());
    mounted!.container.remove();
    mounted = null;
    const forced = render(<DescribedRow nameStyle="label" name="Порт" value="8443" emphasizeValue />);
    expect(forced.firstElementChild!.children[1].firstElementChild!.className).toContain(
      "font-semibold",
    );
  });

  it("no longer truncates — the value wraps (spec §13.2)", () => {
    const el = render(<KVRow label="Ключ" value={"a".repeat(120)} monospace />);
    const value = el.firstElementChild!.children[1].firstElementChild!;
    expect(value.className).not.toContain("truncate");
    expect(value.className).toContain("break-words");
    expect(value.className).toContain("font-mono");
  });
});
