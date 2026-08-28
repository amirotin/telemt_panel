import { useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { IconChevronLeft } from "../../ui/icons";
import { SectionLabel } from "../../ui/SectionLabel";
import { StatePill, type State } from "../../ui/StatePill";
import { formatRelativeAge } from "./formatting";
import type { SourceStatus } from "./sources";
import { sourceStatusLabel, sourceStatusShortLabel } from "./sources";

// STATUS_TONE maps §14's eight page states onto the app's ONE status
// vocabulary (ui/StatePill: ok/warn/error/muted — 06-ui.md deliberately
// keeps a single one). `disabled` and `unsupported` are muted, not warnings:
// a switched-off capability is information, not an alarm (the same choice
// pulse/GatedNote makes).
const STATUS_TONE: Record<SourceStatus, State> = {
  loading: "muted",
  ready: "ok",
  stale: "warn",
  partial: "warn",
  disabled: "muted",
  unsupported: "muted",
  error: "error",
  empty: "muted",
};

export interface DetailHeaderProps {
  title: string;
  /** The page's lede — hidden in compact landscape (§15.3). */
  description?: string;
  /** Uppercase trail above the title ("ПУЛЬС / DETAILS"). */
  breadcrumb?: string;
  /**
   * §15.3's compressed header: on a phone in landscape the whole viewport
   * is 390 px tall, so the secondary trail and the lede are dropped and the
   * title steps down a size. Nothing that carries STATE goes away — the
   * age, the status pill and the back affordance stay.
   */
  compact?: boolean;
  status: SourceStatus;
  /** Normalized epoch ms of the payload on screen (sources.ts). */
  freshnessMs: number | null;
  /** One clock for the whole page. */
  nowMs: number;
  onBack?: () => void;
}

// DetailHeader is §6's header node: back navigation, title/context, a
// freshness indicator that shows the AGE (not just a timestamp — §19.3) and
// the page-level status. The age carries the absolute stamp as its title,
// so the exact moment stays reachable without a second line of chrome.
export function DetailHeader({
  title,
  description,
  breadcrumb,
  compact = false,
  status,
  freshnessMs,
  nowMs,
  onBack,
}: DetailHeaderProps) {
  const s = useStrings();
  const age = freshnessMs === null ? null : formatRelativeAge(freshnessMs, s, nowMs);

  return (
    <header className={cn("flex flex-col", compact ? "gap-1" : "gap-2")}>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="tap-target -ml-2 inline-flex items-center gap-1 self-start px-2 text-meta text-text-muted hover:text-text"
        >
          <IconChevronLeft />
          {s.details.page.back}
        </button>
      )}
      {breadcrumb !== undefined && !compact && (
        <SectionLabel className="text-accent">{breadcrumb}</SectionLabel>
      )}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h1
          className={cn(
            "min-w-0 break-words font-bold text-text",
            compact ? "text-lg" : "text-title",
          )}
        >
          {title}
        </h1>
        <div className="flex shrink-0 items-center gap-2">
          {age && (
            <span className="text-meta tabular-nums text-text-muted" title={age.title}>
              {s.details.freshness.updated} {age.text}
            </span>
          )}
          <StatePill state={STATUS_TONE[status]} title={sourceStatusLabel(status, s)}>
            {sourceStatusShortLabel(status, s)}
          </StatePill>
        </div>
      </div>
      {description !== undefined && description !== "" && !compact && (
        <p className="max-w-prose text-meta leading-relaxed text-text-muted">{description}</p>
      )}
    </header>
  );
}
