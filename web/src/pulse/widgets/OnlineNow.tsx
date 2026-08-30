import { Link } from "@tanstack/react-router";
import { fill, formatNumber, useStrings } from "../../i18n";
import { formatBytes } from "../../lib/format";
import { cn } from "../../lib/cn";
import { Avatar } from "../../ui/Avatar";
import { buttonClasses } from "../../ui/buttonStyles";
import { Skeleton } from "../../ui/Skeleton";
import { IconChevronRight } from "../../ui/icons";
import { quotaFillClass } from "../../ui/quota.helpers";
import { useSnapshot } from "../../realtime";
import type { UsersTopic } from "../../realtime/topics";
import { WidgetFrame } from "../WidgetFrame";
import {
  ONLINE_NOW_LIMIT,
  ONLINE_NOW_LIMIT_PHONE,
  computeOnlineNow,
  type OnlineNowRow,
} from "./onlineNow.helpers";

// OnlineNow — «Онлайн сейчас» (concept §7): who is actually connected right
// now, the busiest of them named, and every row a link into Люди.
//
// The header carries the count and the way out («Онлайн сейчас · 13 из 185»
// + «Все пользователи →»), so the card's height is its rows and nothing
// else — no footer link padding the bottom, no filler when there are fewer
// names than the maximum.
//
// The prototype's row read «4,5 МБ/с · 3 соед», but the "users" topic
// carries no throughput — see people/personMeta.helpers.ts for why the
// panel refuses to invent one. The same substitution is made here:
// connections · unique IPs · cumulative traffic, which is what the topic
// actually knows.
//
// On `lg:` the rows flow in TWO columns, so eight people stand at the
// height four used to. The facts sit immediately after the name — they
// belong to it — and the row's right edge carries only the quota bar and
// the chevron, which is what makes eight right edges line up as one column
// of bars instead of eight ragged runs of digits. Below `lg:` nothing
// changed: one column, five names.
export function OnlineNow({ onHide }: { onHide?: () => void }) {
  const s = useStrings();
  const snapshot = useSnapshot<UsersTopic>("users");
  const view = computeOnlineNow(snapshot.data?.users, ONLINE_NOW_LIMIT, snapshot.data?.quota);

  return (
    <WidgetFrame
      title={s.pulse.widgets.online_now}
      onHide={onHide}
      stale={snapshot.stale}
      badge={
        snapshot.data ? (
          <span className="font-mono text-micro tabular-nums text-text-muted">
            ·{" "}
            {fill(s.overview.onlineOf, {
              online: formatNumber(s, view.online),
              total: formatNumber(s, view.total),
            })}
          </span>
        ) : null
      }
      action={
        <Link to="/people" className={buttonClasses("secondary", "sm", "gap-1")}>
          {s.overview.allUsers}
          <IconChevronRight className="h-3.5 w-3.5" />
        </Link>
      }
    >
      {!snapshot.data ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      ) : view.rows.length === 0 ? (
        <p className="text-meta text-text-muted">{s.overview.onlineEmpty}</p>
      ) : (
        <ul className="grid grid-cols-1 lg:grid-cols-2 lg:gap-x-5">
          {view.rows.map((row, index) => (
            <li
              key={row.username}
              // Eight names fit a desktop card in two columns; a phone shows
              // five, as it always has. One list, cut by CSS — a JS
              // breakpoint would re-render the card on every resize. The
              // hairlines are the phone's separators; two columns of them
              // would draw a grid the card does not need.
              className={cn(
                "min-w-0 border-b border-border last:border-b-0 lg:border-b-0",
                index >= ONLINE_NOW_LIMIT_PHONE && "hidden lg:block",
              )}
            >
              <OnlineRow row={row} />
            </li>
          ))}
        </ul>
      )}
    </WidgetFrame>
  );
}

function OnlineRow({ row }: { row: OnlineNowRow }) {
  const s = useStrings();
  return (
    <Link
      to="/people/$username"
      params={{ username: row.username }}
      data-testid="online-row"
      className="tap-target flex items-center gap-2 rounded-md px-1 transition-colors hover:bg-surface-2"
    >
      <Avatar name={row.username} size="sm" online ringOn="surface" />
      <span className="min-w-0 shrink truncate text-row font-medium text-text">{row.username}</span>
      <span
        data-testid="online-facts"
        className="shrink-0 font-mono text-micro tabular-nums text-text-muted"
      >
        {fill(s.overview.onlineConnectionsShort, { n: formatNumber(s, row.connections) })} ·{" "}
        {formatNumber(s, row.ips)} {s.people.meta.ipShort} · {formatBytes(row.totalOctets, s)}
      </span>
      {/* The slot is there whether or not this person has a cap, so the
          chevrons stay in one column across the card. */}
      <span className="ml-auto h-1 w-10 shrink-0 overflow-hidden rounded-full" data-testid="online-quota">
        {row.quotaFill !== null && (
          <span className="block h-full w-full rounded-full bg-bar-track">
            <span
              className={cn("block h-full rounded-full", quotaFillClass(row.quotaFill, false))}
              style={{ width: `${row.quotaFill * 100}%` }}
            />
          </span>
        )}
      </span>
      <IconChevronRight className="h-3.5 w-3.5 shrink-0 text-text-faint" />
    </Link>
  );
}
