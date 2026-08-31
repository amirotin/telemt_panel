import { Link } from "@tanstack/react-router";
import { fill, formatNumber, useStrings } from "../../i18n";
import { formatDurationApprox } from "../../people/expiry";
import { useNow } from "../../people/useNow";
import { useSnapshot } from "../../realtime";
import type { UsersTopic } from "../../realtime/topics";
import { CountBadge } from "../../ui/Chip";
import { Skeleton } from "../../ui/Skeleton";
import { IconCheck, IconChevronRight, IconWarning } from "../../ui/icons";
import { cn } from "../../lib/cn";
import { WidgetActionLabel } from "../WidgetActionLabel";
import { widgetActionClassName } from "../widgetActionStyles";
import { WidgetFrame } from "../WidgetFrame";
import {
  CLIENT_ATTENTION_LIMIT,
  computeClientAttention,
  type ClientAttentionRow,
  type ClientAttentionSignal,
} from "./onlineNow.helpers";

// The KPI row already answers "how many users and connections are online".
// This block answers the next operator question: which client needs action?
export function OnlineNow() {
  const s = useStrings();
  const snapshot = useSnapshot<UsersTopic>("users");
  const now = useNow();
  const view = computeClientAttention(
    snapshot.data?.users,
    snapshot.data?.quota,
    now,
    CLIENT_ATTENTION_LIMIT,
  );
  const hasErrors = view.rows.some((row) => row.severity === "error");

  return (
    <WidgetFrame
      title={s.pulse.widgets.online_now}
      stale={snapshot.stale}
      badge={
        view.attentionCount > 0 ? (
          <CountBadge tone={hasErrors ? "error" : "warn"}>{view.attentionCount}</CountBadge>
        ) : undefined
      }
      action={
        <Link to="/people" className={widgetActionClassName} data-testid="widget-action">
          <WidgetActionLabel />
        </Link>
      }
    >
      {!snapshot.data ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-4/5" />
        </div>
      ) : (
        <div className="flex min-h-0 flex-col">
          {view.rows.length === 0 ? (
            <div className="flex min-h-[74px] items-center gap-2.5">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-ok/10 text-ok">
                <IconCheck className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-row font-medium text-text">{s.overview.clients.noAttention}</p>
                <p className="mt-0.5 text-micro leading-relaxed text-text-muted">
                  {s.overview.clients.noAttentionHint}
                </p>
              </div>
            </div>
          ) : (
            <>
              <p className="mb-1 text-micro font-semibold uppercase tracking-[0.06em] text-text-faint">
                {s.overview.clients.needsAttention}
              </p>
              <ul className="flex flex-col" data-testid="client-attention-list">
                {view.rows.map((row) => (
                  <li key={row.username} className="border-b border-border last:border-b-0">
                    <ClientAttentionRowView row={row} now={now} />
                  </li>
                ))}
              </ul>
            </>
          )}

          {view.topConcentration && (
            <div className="mt-2 flex items-center gap-2 border-t border-border pt-2 text-micro text-text-muted">
              <span className="min-w-0 flex-1 truncate">{s.overview.clients.concentration}</span>
              <span className="shrink-0 font-mono tabular-nums text-text">
                {fill(s.overview.clients.concentrationValue, {
                  username: view.topConcentration.username,
                  pct: formatNumber(s, view.topConcentration.sharePct),
                })}
              </span>
            </div>
          )}
        </div>
      )}
    </WidgetFrame>
  );
}

function ClientAttentionRowView({ row, now }: { row: ClientAttentionRow; now: number }) {
  const s = useStrings();
  const primary = row.signals[0];
  const extra = row.signals.length - 1;
  return (
    <Link
      to="/people/$username"
      params={{ username: row.username }}
      data-testid="client-attention-row"
      className="tap-target flex min-w-0 items-center gap-2.5 rounded-md px-1 transition-colors hover:bg-surface-2"
    >
      <span
        className={cn(
          "grid h-7 w-7 shrink-0 place-items-center rounded-full",
          row.severity === "error" ? "bg-error/10 text-error" : "bg-warn/10 text-warn",
        )}
      >
        <IconWarning className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-row font-medium text-text">{row.username}</span>
        <span className="mt-0.5 block truncate text-micro text-text-muted">
          {clientSignalText(primary, now, s)}
        </span>
      </span>
      {extra > 0 && (
        <CountBadge tone="muted">
          {fill(s.overview.clients.moreSignals, { count: formatNumber(s, extra) })}
        </CountBadge>
      )}
      <IconChevronRight className="h-3.5 w-3.5 shrink-0 text-text-faint" />
    </Link>
  );
}

function clientSignalText(
  signal: ClientAttentionSignal,
  now: number,
  s: ReturnType<typeof useStrings>,
): string {
  if (signal.kind === "runtime") return s.overview.clients.runtime;
  if (signal.kind === "expiration") {
    const duration = formatDurationApprox(Math.abs(signal.expiresAt - now), s);
    return fill(
      signal.expired ? s.overview.clients.expired : s.overview.clients.expiresIn,
      { duration },
    );
  }
  if (signal.kind === "quota") {
    return fill(s.overview.clients.quota, { pct: formatNumber(s, signal.ratio) });
  }
  const template =
    signal.kind === "connections"
      ? s.overview.clients.connections
      : s.overview.clients.ips;
  return fill(template, {
    current: formatNumber(s, signal.current),
    limit: formatNumber(s, signal.limit),
  });
}
