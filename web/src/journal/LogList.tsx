import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { ru } from "../i18n/ru";
import { Button } from "../ui/Button";
import { isScrolledToBottom } from "./autoscroll.helpers";
import { windowLogLines } from "./logFilter.helpers";
import { LogLineRow } from "./LogLineRow";
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
export function LogList({ lines, showUnit }: LogListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [windowSize, setWindowSize] = useState(INITIAL_WINDOW);
  const [atBottom, setAtBottom] = useState(true);
  const [newSinceScrolledUp, setNewSinceScrolledUp] = useState(0);
  const prevCountRef = useRef(lines.length);
  const atBottomRef = useRef(true);

  const { visible, hiddenCount } = useMemo(() => windowLogLines(lines, windowSize), [lines, windowSize]);

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
    const bottom = isScrolledToBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
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
        className="h-[65dvh] overflow-y-auto rounded-lg border border-border bg-surface px-2 lg:h-[70dvh]"
        data-testid="log-list-scroll"
      >
        {hiddenCount > 0 && (
          <div className="flex justify-center py-2">
            <Button variant="ghost" onClick={() => setWindowSize((w) => w + WINDOW_STEP)}>
              {ru.journal.showEarlier} ({hiddenCount})
            </Button>
          </div>
        )}
        <div className="flex flex-col">
          {visible.map((line) => (
            <LogLineRow key={line.id} line={line} showUnit={showUnit} />
          ))}
        </div>
      </div>

      {!atBottom && newSinceScrolledUp > 0 && (
        <button
          type="button"
          onClick={scrollToNew}
          className={cn(
            "tap-target fixed inset-x-0 z-30 mx-auto w-fit rounded-full bg-accent px-4 py-2",
            "text-sm font-medium text-accent-text shadow-lg",
            "bottom-[calc(4.5rem+env(safe-area-inset-bottom))] lg:bottom-6",
          )}
        >
          {ru.journal.newLinesTemplate.replace("{n}", String(newSinceScrolledUp))}
        </button>
      )}
    </>
  );
}
