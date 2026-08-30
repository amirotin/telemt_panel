import { Link } from "@tanstack/react-router";
import { useSnapshot } from "../../realtime";
import type { UsersTopic } from "../../realtime/topics";
import { Avatar } from "../../ui/Avatar";
import { Skeleton } from "../../ui/Skeleton";
import { buttonClasses } from "../../ui/buttonStyles";
import { IconChevronRight } from "../../ui/icons";
import { quotaFillClass } from "../../ui/quota.helpers";
import { fill, formatNumber, useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { formatDurationApprox } from "../../people/expiry";
import { useNow } from "../../people/useNow";
import { WidgetFrame } from "../WidgetFrame";
import { computeQuotaWatch, type QuotaWatchRow } from "./quotas.helpers";

// QuotasWidget — «Квоты и сроки»: the people whose access is about to stop
// working, for either of the two reasons access stops working. It closes
// Сводка beside «События», half the grid each.
//
// The Люди list already knows all of this, and that is the point: the front
// page's job is to say WHICH of two hundred names needs a decision this
// week, so the card is six rows deep, sorted by urgency, and its empty
// state is one line rather than an illustration of nothing.
export function QuotasWidget({ onHide }: { onHide?: () => void }) {
  const s = useStrings();
  const snapshot = useSnapshot<UsersTopic>("users");
  const now = useNow();
  const rows = computeQuotaWatch(snapshot.data, now);

  return (
    <WidgetFrame
      title={s.pulse.widgets.quotas}
      onHide={onHide}
      stale={snapshot.stale}
      action={
        <Link to="/people" className={buttonClasses("secondary", "sm", "gap-1")}>
          {s.overview.allPeople}
          <IconChevronRight className="h-3.5 w-3.5" />
        </Link>
      }
    >
      {!snapshot.data ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      ) : rows.length === 0 ? (
        // One line, not an empty-state block: "nothing to do" is good news
        // and should take the least room on the page, not the most (§17).
        <p className="text-meta text-text-muted" data-testid="quotas-empty">
          {s.pulse.quotas.empty}
        </p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((row) => (
            <li key={row.username} className="border-b border-border last:border-b-0">
              <QuotaRow row={row} />
            </li>
          ))}
        </ul>
      )}
    </WidgetFrame>
  );
}

function QuotaRow({ row }: { row: QuotaWatchRow }) {
  const s = useStrings();
  const pct = row.quotaFill === null ? null : Math.round(row.quotaFill * 100);

  return (
    <Link
      to="/people/$username"
      params={{ username: row.username }}
      data-testid="quota-row"
      className="tap-target flex items-center gap-2 rounded-md px-1 transition-colors hover:bg-surface-2"
    >
      <Avatar name={row.username} size="sm" ringOn="surface" />
      <span className="min-w-0 shrink truncate text-row font-medium text-text">{row.username}</span>
      {row.quotaFill !== null && (
        <span className="flex shrink-0 items-center gap-1.5" data-testid="quota-bar">
          <span className="block h-1 w-10 overflow-hidden rounded-full bg-bar-track">
            <span
              className={cn("block h-full rounded-full", quotaFillClass(row.quotaFill, false))}
              style={{ width: `${row.quotaFill * 100}%` }}
            />
          </span>
          <span className="font-mono text-micro tabular-nums text-text-muted">
            {formatNumber(s, pct!)} %
          </span>
        </span>
      )}
      <span
        className="ml-auto shrink-0 truncate text-micro tabular-nums text-text-faint"
        data-testid="quota-expiry"
      >
        {row.expiresInMs === null
          ? ""
          : row.expiresInMs <= 0
            ? s.pulse.quotas.expired
            : fill(s.pulse.quotas.expiresIn, {
                duration: formatDurationApprox(row.expiresInMs, s),
              })}
      </span>
      <IconChevronRight className="h-3.5 w-3.5 shrink-0 text-text-faint" />
    </Link>
  );
}
