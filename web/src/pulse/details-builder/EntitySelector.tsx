import { useEffect, useRef } from "react";
import { fill, useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { scrollBehavior } from "../../lib/motion";
import { IconChevronLeft, IconChevronRight } from "../../ui/icons";
import { useRovingFocus } from "./surfaces/rovingFocus";
import { isSplitLayout, type LayoutMode } from "./surfaces/useLayoutMode";

/** One entity's attention marker, already resolved into the reader's language. */
export interface EntityAttention {
  tone: "warn" | "bad";
  reason: string;
}

export interface EntitySelectorProps {
  labels: readonly string[];
  keys: readonly string[];
  activeKey: string | undefined;
  onSelect: (key: string) => void;
  layout: LayoutMode;
  /** Per-entity attention markers, aligned with `keys`; `null` where healthy. */
  attention?: readonly (EntityAttention | null)[];
}

const ATTENTION_DOT: Record<EntityAttention["tone"], string> = {
  warn: "bg-warn",
  bad: "bg-error",
};

// EntitySelector is §6's entity navigation, in the two shapes §15 asks for:
//
//   * compact portrait / medium — the horizontal strip with scroll snap of
//     §15.2, above the content;
//   * compact landscape and wide — a VERTICAL rail beside the content: 80–96
//     px in landscape (ruling R1: never the prototype's 160, and never a
//     300 px desktop master pane), the wider sticky master pane of §15.4 on
//     a desktop.
//
// One component and one React element in both shapes, on purpose: switching
// orientation must not remount anything, because §15.3 forbids a rotation
// from resetting what the reader has open, typed or filtered, and a
// remounted subtree loses exactly that.
//
// Keyboard: the whole strip is ONE tab stop and the arrow keys move inside
// it (§21) — twelve DCs must not mean twelve stops on the way to the page.
export function EntitySelector({
  labels,
  keys,
  activeKey,
  onSelect,
  layout,
  attention,
}: EntitySelectorProps) {
  const s = useStrings();
  const vertical = isSplitLayout(layout);
  const activeIndex = activeKey === undefined ? 0 : Math.max(keys.indexOf(activeKey), 0);
  const roving = useRovingFocus({
    count: keys.length,
    orientation: vertical ? "vertical" : "horizontal",
    activeIndex,
  });

  // Bring the selected entity into view when it changes from anywhere —
  // the pager, a swipe, a deep link, a keyboard arrow. `nearest` so it
  // never scrolls the page itself, and the behaviour honours the reduced-
  // motion preference (§21).
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!list || activeKey === undefined) return;
    const active = Array.from(list.querySelectorAll<HTMLElement>("[data-entity-key]")).find(
      (el) => el.dataset["entityKey"] === activeKey,
    );
    // jsdom implements no scrolling at all, and a key that is not on screen
    // is not an error — both are "nothing to scroll".
    if (typeof active?.scrollIntoView !== "function") return;
    active.scrollIntoView({ behavior: scrollBehavior(), block: "nearest", inline: "nearest" });
  }, [activeKey]);

  return (
    <div
      ref={listRef}
      onKeyDown={roving.onKeyDown}
      role="group"
      aria-label={s.details.selector.label}
      data-testid="entity-selector"
      className={cn(
        vertical
          ? // The rail/master pane scrolls on its own and stays put while
            // the detail column scrolls past it (§15.4's sticky master).
            "sticky top-2 flex max-h-[calc(100dvh-1rem)] shrink-0 flex-col gap-2 self-start overflow-y-auto no-scrollbar"
          : "-mx-4 flex snap-x snap-mandatory gap-2 overflow-x-auto px-4 pb-1",
        layout === "compact-landscape" && "detail-rail",
        layout === "wide" && "detail-master",
      )}
    >
      {keys.map((key, i) => {
        // §21: the dot is the third cue. The word beside it is what a
        // screen reader — and anyone who cannot separate amber from red —
        // actually gets.
        const mark = attention?.[i] ?? null;
        return (
          <button
            key={key}
            type="button"
            data-entity-key={key}
            data-attention={mark?.tone ?? undefined}
            aria-pressed={key === activeKey}
            onClick={() => onSelect(key)}
            {...roving.itemProps(i)}
            className={cn(
              // `relative` is load-bearing, not decoration: the attention
              // marker's sr-only text is `position: absolute`, and without
              // a positioned ancestor INSIDE the horizontally scrolling
              // strip it takes the page as its containing block, escapes
              // the strip's overflow clip and widens the document — twelve
              // live DCs made /pulse/diag/dc scroll sideways by 286 px.
              "tap-target relative flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-left font-mono text-[12.5px] font-semibold",
              !vertical && "snap-start",
              vertical && "w-full break-words",
              key === activeKey
                ? "bg-surface-2 text-text ring-1 ring-accent"
                : "bg-surface text-text-muted hover:bg-surface-2",
            )}
          >
            <span className="min-w-0 flex-1 break-words">{labels[i]}</span>
            {mark !== null && (
              <>
                <span
                  aria-hidden="true"
                  className={cn("size-1.5 shrink-0 rounded-full", ATTENTION_DOT[mark.tone])}
                />
                <span className="sr-only">{mark.reason}</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}

export interface EntityPagerProps {
  /** Zero-based position of the selected entity. */
  index: number;
  total: number;
  previousLabel: string;
  nextLabel: string;
  onPrevious: () => void;
  onNext: () => void;
}

// EntityPager is the visible control §16.2 makes MANDATORY next to the
// swipe: "видимые кнопки previous/next обязательны". The gesture is an
// accelerator on top of it, never the only way through the entities — so
// this renders in every layout mode, including the ones where no gesture
// is attached at all.
//
// It wraps around rather than disabling at the ends: the prototype's own
// pager shows «← DC -203» while DC 1 is selected, and a ring has no dead
// keys to explain.
export function EntityPager({
  index,
  total,
  previousLabel,
  nextLabel,
  onPrevious,
  onNext,
}: EntityPagerProps) {
  const s = useStrings();
  return (
    <div
      className="flex items-center justify-between gap-2"
      data-testid="entity-pager"
    >
      <PagerButton
        direction="previous"
        label={previousLabel}
        ariaLabel={fill(s.details.selector.previousTemplate, { label: previousLabel })}
        onClick={onPrevious}
      />
      <span className="shrink-0 text-meta tabular-nums text-text-faint">
        {fill(s.details.selector.positionTemplate, {
          index: String(index + 1),
          total: String(total),
        })}
      </span>
      <PagerButton
        direction="next"
        label={nextLabel}
        ariaLabel={fill(s.details.selector.nextTemplate, { label: nextLabel })}
        onClick={onNext}
      />
    </div>
  );
}

function PagerButton({
  direction,
  label,
  ariaLabel,
  onClick,
}: {
  direction: "previous" | "next";
  label: string;
  ariaLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      data-testid={`entity-pager-${direction}`}
      className={cn(
        "tap-target inline-flex min-w-0 items-center gap-1 rounded-xl bg-surface px-3 py-2",
        "font-mono text-[12.5px] font-semibold text-text-muted hover:bg-surface-2 hover:text-text",
      )}
    >
      {direction === "previous" && (
        <span aria-hidden="true" className="shrink-0">
          <IconChevronLeft />
        </span>
      )}
      <span className="truncate">{label}</span>
      {direction === "next" && (
        <span aria-hidden="true" className="shrink-0">
          <IconChevronRight />
        </span>
      )}
    </button>
  );
}
