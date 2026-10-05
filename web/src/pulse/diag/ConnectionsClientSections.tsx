import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { formatNumber, type Dict } from "../../i18n";
import { formatBytes } from "../../lib/format";
import type { ClassCount, RuntimeEdgeConnectionUser } from "../../realtime/topics";
import { formatPercent } from "../formatting";

export type RankingMode = "current" | "traffic";

function classLabel(name: string, s: Dict): string {
  const labels: Record<string, string> = {
    tls_handshake_bad_client: s.details.pages.connections.view.badTlsClient,
    tls_mtproto_bad_client: s.details.pages.connections.view.badMtprotoClient,
    direct_modes_disabled: s.details.pages.connections.view.directDisabled,
  };
  return labels[name] ?? name.replaceAll("_", " ");
}

export function ReasonRows({ rows, total, s }: { rows: readonly ClassCount[]; total: number; s: Dict }) {
  const ordered = useMemo(() => [...rows].sort((a, b) => b.total - a.total).slice(0, 4), [rows]);

  if (ordered.length === 0) {
    return <p className="mt-5 text-meta text-text-muted">{s.details.pages.connections.view.noReasons}</p>;
  }

  return (
    <div className="mt-5 flex flex-col gap-4" data-testid="connections-reasons">
      {ordered.map((row) => {
        const share = total > 0 ? (row.total / total) * 100 : 0;
        return (
          <div key={row.class}>
            <div className="flex items-end justify-between gap-4">
              <div className="min-w-0">
                <p className="truncate text-meta font-semibold text-text" title={classLabel(row.class, s)}>
                  {classLabel(row.class, s)}
                </p>
                <p className="truncate font-mono text-micro text-text-muted" title={row.class}>
                  {row.class}
                </p>
              </div>
              <span className="shrink-0 text-meta font-semibold tabular-nums text-text">
                {formatNumber(s, row.total)}
              </span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${Math.max(1.5, Math.min(100, share))}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ClientRanking({
  rows,
  mode,
  totalConnections,
  s,
}: {
  rows: readonly RuntimeEdgeConnectionUser[];
  mode: RankingMode;
  totalConnections: number | null;
  s: Dict;
}) {
  const visible = rows.slice(0, 5);
  const covered = visible.reduce((sum, row) => sum + row.current_connections, 0);
  const share = totalConnections && totalConnections > 0 ? (covered / totalConnections) * 100 : null;

  if (visible.length === 0) {
    return <p className="mt-5 text-meta text-text-muted">{s.details.pages.connections.view.noClients}</p>;
  }

  return (
    <>
      <ol className="mt-4 flex flex-col gap-1.5" data-testid="connections-clients">
        {visible.map((row, index) => (
          <li key={row.username}>
            <Link
              to="/people/$username"
              params={{ username: row.username }}
              className="group grid min-h-12 grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-2 transition-colors hover:bg-surface-3"
            >
              <span className="text-micro tabular-nums text-text-muted">{index + 1}</span>
              <span className="min-w-0">
                <strong className="block truncate text-meta text-text group-hover:text-accent">
                  {row.username}
                </strong>
                <span className="block truncate text-micro text-text-muted">
                  {formatBytes(row.total_octets, s)} {s.details.pages.connections.view.sinceStart}
                </span>
              </span>
              <span className="text-right">
                <strong className="block text-meta tabular-nums text-text">
                  {mode === "current"
                    ? formatNumber(s, row.current_connections)
                    : formatBytes(row.total_octets, s)}
                </strong>
                <span className="block text-micro text-text-muted">
                  {mode === "current"
                    ? s.details.pages.connections.view.connections
                    : s.details.pages.connections.view.traffic}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
      {totalConnections !== null && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-micro text-text-muted">
          <span>
            {s.details.pages.connections.view.topClients}: {formatNumber(s, covered)} / {formatNumber(s, totalConnections)}
          </span>
          <strong className="tabular-nums text-accent">{formatPercent(share, s, { precision: 0 })}</strong>
        </div>
      )}
    </>
  );
}
