import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { tabElementId } from "./DetailPage.helpers";
import { useRovingFocus } from "./surfaces/rovingFocus";

export interface SectionTab {
  id: string;
  label: string;
}

export interface SectionTabsProps {
  tabs: readonly SectionTab[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
  /** DOM id of the panel these tabs control (§21: tablist/tab/tabpanel). */
  panelId: string;
  label: string;
}

// SectionTabs is the sticky segmented control of §15.2, wired as the full
// ARIA tabs pattern §21 asks for: a `tablist` of `tab`s pointing at one
// `tabpanel`, arrow keys moving the focus inside a single tab stop, and
// MANUAL activation (arrow to look, Enter/Space to switch).
//
// Manual rather than automatic activation because switching a tab here
// re-resolves a section list of up to two thousand leaves: arrowing across
// four tabs would rebuild all of them on the way past.
export function SectionTabs({ tabs, activeId, onSelect, panelId, label }: SectionTabsProps) {
  const activeIndex = Math.max(
    tabs.findIndex((tab) => tab.id === activeId),
    0,
  );
  const roving = useRovingFocus({
    count: tabs.length,
    orientation: "horizontal",
    activeIndex,
  });
  const listRef = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState({ start: false, end: false });

  // Keyboard focus already drags a tab into view; a tab restored FROM THE
  // ROUTE never does, so ME opened on «Рантайм» at 360 px with the strip
  // still showing «Обзор». Scrolling the strip itself rather than calling
  // scrollIntoView keeps the page's own scroll position untouched.
  useEffect(() => {
    const list = listRef.current;
    const tab = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !tab) return;
    const left = tab.offsetLeft - list.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < list.scrollLeft) list.scrollLeft = left;
    else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth;
  }, [activeId]);

  // Five tabs at 360 px leave «Инициа…» clipped by a glyph as the only sign
  // there is more to the right. A fade on the overflowing side says it
  // instead — and it appears only while the strip actually overflows.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () =>
      setClipped({
        start: list.scrollLeft > 1,
        end: list.scrollLeft + list.clientWidth < list.scrollWidth - 1,
      });
    measure();
    list.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(list);
    return () => {
      list.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, []);

  return (
    <div className="relative -mx-4">
      <div
        ref={listRef}
        role="tablist"
        aria-label={label}
        aria-orientation="horizontal"
        onKeyDown={roving.onKeyDown}
        className="flex gap-2 overflow-x-auto px-4"
      >
        {tabs.map((tab, i) => {
          const selected = tab.id === activeId;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={tabElementId(panelId, tab.id)}
              aria-selected={selected}
              aria-controls={panelId}
              onClick={() => onSelect(tab.id)}
              {...roving.itemProps(i)}
              className={cn(
                "tap-target shrink-0 rounded-lg px-3 text-meta font-semibold",
                selected ? "bg-surface-2 text-text" : "text-text-muted hover:text-text",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {clipped.start && (
        <span
          className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-bg to-transparent"
          aria-hidden="true"
        />
      )}
      {clipped.end && (
        <span
          className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-bg to-transparent"
          aria-hidden="true"
        />
      )}
    </div>
  );
}
