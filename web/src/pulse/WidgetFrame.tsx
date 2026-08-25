import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "../lib/cn";
import { ru } from "../i18n/ru";
import { IconButton } from "../ui/IconButton";
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
  className?: string;
  children: ReactNode;
}

// WidgetFrame is the one card shell every dashboard widget renders inside —
// title, optional drill-down link, optional "hide" action, optional stale
// badge (06-ui.md: widgets reuse shared primitives, "никаких 11 самодельных
// вёрсток"). A widget in the Gated/loading/error state still renders inside
// this frame (its own body decides what to show), so the title/hide/diag
// affordances stay available regardless of the underlying data's state.
export function WidgetFrame({
  title,
  diagDomain,
  onHide,
  stale,
  className,
  children,
}: WidgetFrameProps) {
  return (
    <div className={cn("flex flex-col gap-3 rounded-xl border border-border bg-surface p-4", className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-sm font-semibold text-text">{title}</h3>
          {stale && <StatePill state="warn">{ru.common.stale}</StatePill>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {diagDomain && (
            <Link
              to="/pulse/diag/$domain"
              params={{ domain: diagDomain }}
              className="tap-target flex items-center px-2 text-xs font-medium text-accent hover:underline"
            >
              {ru.pulse.diagLink}
            </Link>
          )}
          {onHide && (
            <IconButton aria-label={ru.pulse.hideWidget} onClick={onHide}>
              ×
            </IconButton>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}
