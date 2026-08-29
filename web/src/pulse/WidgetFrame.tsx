import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "../lib/cn";
import { useStrings } from "../i18n";
import { IconButton } from "../ui/IconButton";
import { IconChevronRight, IconClose } from "../ui/icons";
import { StatePill } from "../ui/StatePill";
import type { DiagDomain } from "./types";

export interface WidgetFrameProps {
  title: string;
  /** Links to the matching Диагностика drill-down page, when the widget has one. */
  diagDomain?: DiagDomain;
  /** "Скрыть виджет" action — wired to the layout store by PulseDashboard. */
  onHide?: () => void;
  /** SSE topic staleness (useSnapshot's `.stale`) — shown as a badge, data stays visible underneath. */
  stale?: boolean;
  /** Trailing slot on the title row, before the actions (a count, a state pill). */
  badge?: ReactNode;
  /**
   * The widget's own control at the right of the title row — «Все
   * пользователи →» and its like. Concept §7 puts it in the header rather
   * than on a line of its own under the card, so the card's height is its
   * rows and nothing else.
   */
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}

// WidgetFrame is the one card shell every dashboard widget renders inside —
// title, optional drill-down link, optional "hide" action, optional stale
// badge (06-ui.md: widgets reuse shared primitives, "никаких 11 самодельных
// вёрсток"). A widget in the Gated/loading/error state still renders inside
// this frame (its own body decides what to show), so the title/hide/diag
// affordances stay available regardless of the underlying data's state.
//
// The prototype's card is a flat `--sur` block with a 14px radius and no
// outline — the border is kept because on the light theme `--surface` is
// pure white against a near-white page and the card would otherwise have no
// edge at all; `--border` is subtle enough on dark not to read as a
// hairline box.
export function WidgetFrame({
  title,
  diagDomain,
  onHide,
  stale,
  badge,
  action,
  className,
  children,
}: WidgetFrameProps) {
  const s = useStrings();
  return (
    <div className={cn("flex flex-col gap-2.5 rounded-xl border border-border bg-surface p-3.5", className)}>
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {/* h2, not h3: a widget is a top-level section of Сводка and there
              is no intermediate heading above it — h1 straight to h3 left a
              gap in the outline a screen reader reads as a missing level. */}
          <h2 className="truncate text-[13px] font-semibold text-text">{title}</h2>
          {badge}
          {stale && <StatePill state="warn">{s.common.stale}</StatePill>}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {action}
          {diagDomain && (
            <Link
              to="/pulse/diag/$domain"
              params={{ domain: diagDomain }}
              className="inline-flex min-h-[32px] items-center gap-0.5 rounded-md px-2 text-micro font-semibold text-accent transition-colors hover:bg-accent/12"
            >
              {s.pulse.diagLink}
              <IconChevronRight className="h-3.5 w-3.5" />
            </Link>
          )}
          {onHide && (
            <IconButton
              aria-label={s.pulse.hideWidget}
              onClick={onHide}
              className="text-[15px]"
            >
              <IconClose />
            </IconButton>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}
