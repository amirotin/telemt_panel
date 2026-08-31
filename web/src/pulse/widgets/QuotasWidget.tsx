import { Link } from "@tanstack/react-router";
import { useSnapshot } from "../../realtime";
import type { UsersTopic } from "../../realtime/topics";
import { Avatar } from "../../ui/Avatar";
import { Skeleton } from "../../ui/Skeleton";
import { IconChevronRight } from "../../ui/icons";
import { quotaFillClass } from "../../ui/quota.helpers";
import { fill, formatNumber, useStrings } from "../../i18n";
import { cn } from "../../lib/cn";
import { formatDurationApprox } from "../../people/expiry";
import { useNow } from "../../people/useNow";
import { WidgetActionLabel } from "../WidgetActionLabel";
import { widgetActionClassName } from "../widgetActionStyles";
import { WidgetFrame } from "../WidgetFrame";
import { computeQuotaWatch, type QuotaWatchRow } from "./quotas.helpers";

// QuotasWidget — «Квоты и сроки»: the people whose access is about to stop
// working, for either of the two reasons access stops working. It closes
// Сводка only when somebody needs attention.
//
// The Люди list already knows all of this, and that is the point: the front
// page's job is to say WHICH of two hundred names needs a decision this
// week, so the card is six rows deep, sorted by urgency, and its empty
// state is one line rather than an illustration of nothing.
export function QuotasWidget() {
  const s = useStrings();
  const snapshot = useSnapshot<UsersTopic>("users");
  const now = useNow();
  const rows = computeQuotaWatch(snapshot.data, now);

  // Healthy quota state is already covered by the attention strip. Overview
  // spends a full row here only when somebody actually needs a decision.
  if (snapshot.data && rows.length === 0) return null;

  return (
    <WidgetFrame
      title={s.pulse.widgets.quotas}
      className="lg:col-span-12"
      stale={snapshot.stale}
      action={
        <Link to="/people" className={widgetActionClassName} data-testid="widget-action">
          <WidgetActionLabel />
        </Link>
      }
    >
      {!snapshot.data ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-2/3" />
        </div>
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
