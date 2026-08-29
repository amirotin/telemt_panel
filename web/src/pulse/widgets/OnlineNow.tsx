import { Link } from "@tanstack/react-router";
import { countLabel, fill, formatNumber, useStrings } from "../../i18n";
import { formatBytes } from "../../lib/format";
import { Avatar } from "../../ui/Avatar";
import { Skeleton } from "../../ui/Skeleton";
import { IconChevronRight } from "../../ui/icons";
import { useSnapshot } from "../../realtime";
import type { UsersTopic } from "../../realtime/topics";
import { WidgetFrame } from "../WidgetFrame";
import { computeOnlineNow } from "./onlineNow.helpers";

// OnlineNow — the prototype's «Онлайн сейчас» block on Сводка: who is
// actually connected right now, with the busiest five named and every row a
// link into Люди.
//
// The prototype's row reads «4,5 МБ/с · 3 соед», but the "users" topic
// carries no throughput — see people/personMeta.helpers.ts for why the
// panel refuses to invent one. The same substitution is made here:
// connections · unique IPs · cumulative traffic, which is what the topic
// actually knows.
export function OnlineNow({ onHide }: { onHide?: () => void }) {
  const s = useStrings();
  const snapshot = useSnapshot<UsersTopic>("users");
  const view = computeOnlineNow(snapshot.data?.users);

  return (
    <WidgetFrame
      title={s.pulse.widgets.online_now}
      onHide={onHide}
      stale={snapshot.stale}
      badge={
        snapshot.data ? (
          <span className="font-mono text-micro tabular-nums text-text-muted">
            {fill(s.overview.onlineOf, {
              online: formatNumber(s, view.online),
              total: formatNumber(s, view.total),
            })}
          </span>
        ) : null
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
        <ul className="flex flex-col">
          {view.rows.map((row) => (
            <li key={row.username} className="border-b border-border last:border-b-0">
              <Link
                to="/people/$username"
                params={{ username: row.username }}
                className="tap-target flex items-center gap-2.5 rounded-md px-1 transition-colors hover:bg-surface-2"
              >
                <Avatar name={row.username} size="sm" online ringOn="surface" />
                <span className="min-w-0 flex-1 truncate text-row font-medium text-text">
                  {row.username}
                </span>
                <span className="shrink-0 font-mono text-micro tabular-nums text-text-muted">
                  {countLabel(s, row.connections, s.shell.connectionsUnit)} ·{" "}
                  {formatNumber(s, row.ips)} {s.people.meta.ipShort} ·{" "}
                  {formatBytes(row.totalOctets, s)}
                </span>
                <IconChevronRight className="h-3.5 w-3.5 shrink-0 text-text-faint" />
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Link
        to="/people"
        className="inline-flex min-h-[32px] items-center gap-0.5 self-start rounded-md px-1 text-micro font-semibold text-accent transition-colors hover:bg-accent/12"
      >
        {s.overview.allPeople}
        <IconChevronRight className="h-3.5 w-3.5" />
      </Link>
    </WidgetFrame>
  );
}
