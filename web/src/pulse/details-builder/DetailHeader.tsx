import { useStrings } from "../../i18n";
import { IconChevronLeft } from "../../ui/icons";
import { SectionLabel } from "../../ui/SectionLabel";
import { StatePill, type State } from "../../ui/StatePill";
import { formatRelativeAge } from "./formatting";
import type { SourceStatus } from "./sources";
import { sourceStatusLabel } from "./sources";

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
  /** The page's lede — hidden in compact landscape by Task 5 (§15.3). */
  description?: string;
  /** Uppercase trail above the title ("ПУЛЬС / DETAILS"). */
  breadcrumb?: string;
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
  status,
  freshnessMs,
  nowMs,
  onBack,
}: DetailHeaderProps) {
  const s = useStrings();
  const age = freshnessMs === null ? null : formatRelativeAge(freshnessMs, s, nowMs);

  return (
    <header className="flex flex-col gap-2">
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
      {breadcrumb !== undefined && <SectionLabel className="text-accent">{breadcrumb}</SectionLabel>}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h1 className="min-w-0 break-words text-title font-bold text-text">{title}</h1>
        <div className="flex shrink-0 items-center gap-2">
          {age && (
            <span className="text-meta tabular-nums text-text-muted" title={age.title}>
              {s.details.freshness.updated} {age.text}
            </span>
          )}
          <StatePill state={STATUS_TONE[status]}>{sourceStatusLabel(status, s)}</StatePill>
        </div>
      </div>
      {description !== undefined && description !== "" && (
        <p className="max-w-prose text-meta leading-relaxed text-text-muted">{description}</p>
      )}
    </header>
  );
}
