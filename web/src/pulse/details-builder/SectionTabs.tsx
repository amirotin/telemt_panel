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

  return (
    <div
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      onKeyDown={roving.onKeyDown}
      className="-mx-4 flex gap-2 overflow-x-auto px-4"
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
  );
}
