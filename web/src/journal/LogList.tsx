import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { ru } from "../i18n/ru";
import { Button } from "../ui/Button";
import { IconArrowDown } from "../ui/icons";
import { isScrolledToBottom } from "./autoscroll.helpers";
import { windowLogLines } from "./logFilter.helpers";
import { LogLineRow } from "./LogLineRow";
import { gridColumnsClass } from "./logColumns";
import type { RingLine } from "./logRing";

const INITIAL_WINDOW = 500;
const WINDOW_STEP = 500;

export interface LogListProps {
  /** Already filtered by level + search (LogsTab's job); newest last. */
  lines: RingLine[];
  showUnit: boolean;
}

// LogList — Task 7 deliverable A's log feed: a "keep it simple"
// virtualization (only the newest `windowSize` lines render, with a
// "показать раньше" control instead of a virtualization dependency),
// autoscroll-to-bottom while the user hasn't scrolled up, and a floating
// "к новым" button when they have. That button is `position: fixed`
// (escapes this component's own scroll container/layout entirely) rather
// than absolutely positioned within the list, specifically so it always
// sits above the mobile bottom tab bar with the real safe-area inset — the
// v1 lesson design-brief.md §3 calls out: a value merely tuned to look
// right in one browser/device drifts out from under the tab bar's actual
// (safe-area-dependent) height on another.
//
// At `lg:` the frame adds a fixed `w-56` sidebar (Shell.tsx) to the left
// of the content column, so a viewport-wide `inset-x-0` centers the
// button under the sidebar+content combined, visibly off-center from the
// content the user is actually reading. `lg:left-56 lg:right-0` narrows
// the centering box to the content column alone (viewport minus the
// sidebar's own width, matching Shell's `w-56`), so `mx-auto` centers
// against the same column instead.
export function LogList({ lines, showUnit }: LogListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [windowSize, setWindowSize] = useState(INITIAL_WINDOW);
  const [atBottom, setAtBottom] = useState(true);
  const [newSinceScrolledUp, setNewSinceScrolledUp] = useState(0);
  const prevCountRef = useRef(lines.length);
  const atBottomRef = useRef(true);

  const { visible, hiddenCount } = useMemo(
    () => windowLogLines(lines, windowSize),
    [lines, windowSize],
  );

  useEffect(() => {
    const grew = lines.length - prevCountRef.current;
    prevCountRef.current = lines.length;
    if (grew <= 0) return;
    if (atBottomRef.current) {
      const el = containerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    } else {
      setNewSinceScrolledUp((n) => n + grew);
    }
  }, [lines.length]);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const bottom = isScrolledToBottom(
      el.scrollTop,
      el.clientHeight,
      el.scrollHeight,
    );
    atBottomRef.current = bottom;
    setAtBottom(bottom);
    if (bottom) setNewSinceScrolledUp(0);
  }

  function scrollToNew() {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setAtBottom(true);
    setNewSinceScrolledUp(0);
  }

  return (
    <>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        // A fixed viewport-relative height (rather than flex-1/min-h-0)
        // because the only real scroll container in this app's layout is
        // Shell's <main> (overflow-y-auto) — there's no bounded-height flex
        // ancestor here for flex-1 to resolve against. This pane needs its
        // own independent scroll region so autoscroll-to-bottom and
        // "показать раньше" behave against a genuinely clipped viewport
        // instead of the whole page growing to fit every line.
        // `bg-surface-sunken` is the prototype's recessed log well: the feed
        // reads as a pane cut into the page, not as another card sitting on
        // it, which is what keeps a wall of monospace from competing with
        // the toolbar above it.
        className={cn(
          "h-[65dvh] overflow-y-auto rounded-xl border border-border bg-surface-sunken lg:h-[70dvh]",
          "px-3 py-2.5 lg:px-0 lg:py-0",
        )}
        data-testid="log-list-scroll"
      >
        {/*
          The prototype's column header. Sticky inside the scroller (rather
          than sitting above it) so the columns stay labelled while the feed
          scrolls; hidden below `lg:`, where the rows are bubbles with an
          inline meta line and there are no columns to caption.
        */}
        <div
          className={cn(
            "sticky top-0 z-10 hidden bg-surface-sunken px-3.5 py-1.5",
            "border-b border-border text-micro font-semibold uppercase tracking-[0.06em] text-text-faint",
            "lg:grid lg:gap-x-2.5",
            gridColumnsClass(showUnit),
          )}
          aria-hidden="true"
        >
          <span>{ru.journal.timeColumn}</span>
          <span>{ru.journal.levelColumn}</span>
          {showUnit && <span>{ru.journal.unitColumn}</span>}
          <span>{ru.journal.messageColumn}</span>
        </div>

        {hiddenCount > 0 && (
          <div className="flex justify-center py-2">
            <Button
              variant="ghost"
              onClick={() => setWindowSize((w) => w + WINDOW_STEP)}
            >
              {ru.journal.showEarlier} ({hiddenCount})
            </Button>
          </div>
        )}
        <div className="flex flex-col gap-2 lg:gap-0">
          {visible.map((line) => (
            <LogLineRow key={line.id} line={line} showUnit={showUnit} />
          ))}
        </div>
      </div>

      {!atBottom && newSinceScrolledUp > 0 && (
        <button
          type="button"
          onClick={scrollToNew}
          // The glow is written inline rather than as an arbitrary
          // `shadow-[...]` utility: the value needs the accent token at 40%
          // alpha, and a "/" inside a Tailwind arbitrary value is parsed as
          // an opacity modifier rather than passed through to the CSS.
          style={{ boxShadow: "0 6px 16px rgb(var(--accent) / 0.4)" }}
          className={cn(
            // Keeps the 44px floor even though the prototype draws this pill
            // at ~38px: it is the one floating control on a phone screen.
            "tap-target fixed inset-x-0 z-30 mx-auto inline-flex w-fit items-center justify-center gap-1.5 rounded-full",
            "bg-accent-strong px-4 py-2.5 text-xs font-semibold text-accent-text",
            "transition-colors hover:bg-accent",
            "bottom-[calc(4.5rem+env(safe-area-inset-bottom))] lg:bottom-6",
            "lg:left-56 lg:right-0",
          )}
        >
          <IconArrowDown aria-hidden="true" />
          {ru.journal.jumpToNewTemplate.replace(
            "{n}",
            String(newSinceScrolledUp),
          )}
        </button>
      )}
    </>
  );
}
