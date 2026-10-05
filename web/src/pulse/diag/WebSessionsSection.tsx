import { useMemo, useState } from "react";
import { fill, formatNumber, type Dict } from "../../i18n";
import type { WebSessionRow } from "../../lib/api/generated/types.gen";
import { cn } from "../../lib/cn";
import { formatBytes } from "../../lib/format";
import { IconChevronRight, IconWarning } from "../../ui/icons";
import { WEB_CLOSE_MAX_REFS, WEB_FILTER_CARRIER, WEB_FILTER_STATE, webCloseIntent, type CloseIntent, type FilterValue, type WebPagePayload } from "./web.helpers";
import { webSessionMatches, webSessionStateTone, type WebSessionFilter } from "./web.view.helpers";
import { formatDiagnosticDuration, formatCoarseDuration as formatDurationApprox } from "../formatting";
import { SectionHeading } from "./SectionHeading";
function formatWebDuration(ms: number, s: Dict): string {
  return formatDiagnosticDuration(ms, s, { inputUnit: "milliseconds", minimumUnit: "seconds", precision: ms < 60_000 ? 3 : 0, rounding: ms < 60_000 ? "round" : "floor" });
}

const SESSION_REVEAL_SIZE = 8;

function SessionRow({ row, s, onOpen }: { row: WebSessionRow; s: Dict; onOpen: () => void }) {
  const v = s.details.pages.web.view;
  const tone = webSessionStateTone(row.state);
  return (
    <article
      className="min-w-0 border-b border-border"
      data-web-session={row.session_ref}
      data-web-session-state={row.state}
      data-web-session-carrier={row.carrier}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={fill(v.openSessionDetailsTemplate, { user: row.user, ip: row.client_ip })}
        className="group grid min-h-11 w-full min-w-0 gap-3 px-3 py-4 text-left hover:bg-surface-3/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent lg:grid-cols-[1.1fr_1fr_0.7fr_1.15fr_1fr_auto] lg:items-center"
      >
        <div className="min-w-0">
          <span
            className={cn(
              "inline-flex rounded-md px-2 py-1 text-label font-bold uppercase",
              tone === "good"
                ? "bg-ok/15 text-ok"
                : tone === "warn"
                  ? "bg-warn/15 text-warn"
                  : "bg-surface-3 text-text-muted",
            )}
          >
            {row.state}
          </span>
          <strong className="mt-2 block break-words text-meta text-text">{row.user}</strong>
          <small
            className="mt-1 block truncate font-mono text-micro text-text-muted"
            title={row.session_ref}
          >
            {row.session_ref}
          </small>
        </div>
        <div className="min-w-0">
          <strong className="block break-words text-meta text-text">{row.carrier}</strong>
          <span className="mt-1 block font-mono text-micro text-text-muted">{row.client_ip}</span>
          <small className="mt-1 block break-all text-micro text-text-muted">{row.host}</small>
        </div>
        <div>
          <strong className="block text-meta tabular-nums text-text">
            {formatDurationApprox(row.age_ms, s)}
          </strong>
          <span className="mt-1 block text-micro text-text-muted">{v.age}</span>
          <small className="mt-1 block text-micro text-text-muted">
            {fill(v.idleTemplate, { age: formatDurationApprox(row.idle_ms, s) })}
          </small>
        </div>
        <div>
          <strong className="block text-meta text-text">
            {fill(v.sessionLoadTemplate, { streams: formatNumber(s, row.streams), lanes: formatNumber(s, row.lanes) })}
          </strong>
          <span className="mt-1 block text-micro text-text-muted">
            {fill(v.pendingTemplate, { bytes: formatBytes(row.pending_bytes, s) })}
          </span>
          <small className="mt-1 block text-micro text-text-muted">
            {row.client_class} · {row.automatic ? v.automaticMode : v.manualMode}
          </small>
        </div>
        <span className="min-w-0 break-words text-micro text-text-muted">
          {row.user_agent || v.userAgentMissing}
        </span>
        <IconChevronRight className="hidden shrink-0 text-text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-accent lg:block" />
      </button>
    </article>
  );
}

function SessionDetailGroup({
  title,
  rows,
}: {
  title: string;
  rows: Array<[label: string, value: string]>;
}) {
  return (
    <section>
      <h3 className="text-label font-bold uppercase tracking-[0.12em] text-text-muted">{title}</h3>
      <dl className="mt-2 overflow-hidden rounded-xl border border-border bg-surface-2">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="grid min-w-0 gap-1 border-b border-border px-3 py-2.5 last:border-b-0 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] sm:gap-3"
          >
            <dt className="break-all font-mono text-micro text-text-muted">{label}</dt>
            <dd className="break-all font-mono text-meta font-semibold text-text sm:text-right">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
export function SessionDetails({
  row,
  s,
  canClose,
  closePending,
  onClose,
}: {
  row: WebSessionRow;
  s: Dict;
  canClose: boolean;
  closePending: boolean;
  onClose: () => void;
}) {
  const web = s.details.pages.web;
  const v = web.view;
  const missing = "—";
  return (
    <div className="space-y-4" data-testid="web-session-details">
      <SessionDetailGroup
        title={v.sessionIdentity}
        rows={[
          ["session_ref", row.session_ref],
          ["user", row.user],
          ["key_id", row.key_id],
          ["client_ip", row.client_ip],
          ["host", row.host],
          ["trace_session_id", formatNumber(s, row.trace_session_id)],
          ["user_agent", row.user_agent || v.userAgentMissing],
          ["user_agent_id", row.user_agent_id || missing],
        ]}
      />
      <SessionDetailGroup
        title={v.sessionTransport}
        rows={[
          ["carrier", row.carrier],
          ["client_class", row.client_class],
          ["state", row.state],
          ...(row.health_publication === undefined ? [] : [["health_publication", v.healthPublicationStates[row.health_publication as keyof typeof v.healthPublicationStates] ?? row.health_publication] as [string,string]]),
          ["attempt", formatNumber(s, row.attempt)],
          ["automatic", row.automatic ? s.common.yes : s.common.no],
          ["websocket_active", row.websocket_active ? s.common.yes : s.common.no],
        ]}
      />
      <SessionDetailGroup
        title={v.sessionActivity}
        rows={[
          ["age_ms", formatDurationApprox(row.age_ms, s)],
          ["idle_ms", formatDurationApprox(row.idle_ms, s)],
          ...(["peer_idle_ms","reconnect_grace_ms","peer_deadline_remaining_ms"] as const).flatMap(key => row[key] === undefined ? [] : [[key,formatWebDuration(row[key],s)] as [string,string]]),
          [
            "negotiation_remaining_ms",
            row.negotiation_remaining_ms === undefined
              ? missing
              : formatDurationApprox(row.negotiation_remaining_ms, s),
          ],
          ["streams", formatNumber(s, row.streams)],
          ["tasks", formatNumber(s, row.tasks)],
          ["lanes", formatNumber(s, row.lanes)],
          ["lane_open_waits", formatNumber(s, row.lane_open_waits)],
          ["websocket_lane_reservations", formatNumber(s, row.websocket_lane_reservations)],
        ]}
      />
      <SessionDetailGroup
        title={v.sessionQueues}
        rows={[
          ["pending_bytes", formatBytes(row.pending_bytes, s)],
          ["pending_items", formatNumber(s, row.pending_items)],
          ["control_bytes", formatBytes(row.control_bytes, s)],
          ["control_items", formatNumber(s, row.control_items)],
        ]}
      />
      <div className="flex justify-end border-t border-border pt-4">
        <button
          type="button"
          disabled={!canClose || closePending}
          onClick={onClose}
          className="min-h-10 rounded-lg border border-error/45 bg-error/10 px-4 py-2 text-meta font-semibold text-error-text disabled:cursor-not-allowed disabled:opacity-40"
        >
          {web.closeSession}
        </button>
      </div>
    </div>
  );
}

export function SessionsView({
  payload,
  pending,
  error,
  fetchingMore,
  hasMore,
  closePending,
  canClose,
  issuanceEnabled,
  onRetry,
  onLoadMore,
  onIntent,
  onOpenSession,
  s,
}: {
  payload: WebPagePayload;
  pending: boolean;
  error: boolean;
  fetchingMore: boolean;
  hasMore: boolean;
  closePending: boolean;
  canClose: boolean;
  issuanceEnabled: boolean;
  onRetry: () => void;
  onLoadMore: () => void;
  onIntent: (intent: CloseIntent) => void;
  onOpenSession: (row: WebSessionRow) => void;
  s: Dict;
}) {
  const v = s.details.pages.web.view;
  const [filter, setFilter] = useState<WebSessionFilter>("all");
  const [query, setQuery] = useState("");
  const [visibleLimit, setVisibleLimit] = useState(SESSION_REVEAL_SIZE);
  const sessionRows = payload.sessions?.rows;
  const rows = useMemo(() => sessionRows ?? [], [sessionRows]);
  const managerTotal = payload.runtime?.manager?.sessions ?? null;
  const managerBusy =
    payload.runtime?.partial.includes("manager") || payload.sessions?.partial.includes("manager");
  const filtered = useMemo(
    () => rows.filter((row) => webSessionMatches(row, filter, query)),
    [filter, query, rows],
  );
  const visible = filtered.slice(0, visibleLimit);
  const filters: Record<string, FilterValue> = {};
  if (filter === "https-lanes" || filter === "websocket") filters[WEB_FILTER_CARRIER] = filter;
  if (filter === "healthy" || filter === "provisional") filters[WEB_FILTER_STATE] = filter;
  const bulkIntent = webCloseIntent({
    filters,
    visibleKeys: filtered.map((row) => row.session_ref),
    narrowed: query.trim() !== "",
  });
  const stateCounts = new Map<string, number>();
  const carrierCounts = new Map<string, number>();
  for (const row of rows) {
    stateCounts.set(row.state, (stateCounts.get(row.state) ?? 0) + 1);
    carrierCounts.set(row.carrier, (carrierCounts.get(row.carrier) ?? 0) + 1);
  }
  const breakdown = (counts: Map<string, number>) =>
    [...counts].map(([name, count]) => `${formatNumber(s, count)} ${name}`).join(" · ") || "—";
  const loadedLabel =
    managerTotal !== null && managerTotal === rows.length && !hasMore
      ? fill(v.loadedAllTemplate, { count: formatNumber(s, rows.length) })
      : fill(v.loadedPartialTemplate, {
          count: formatNumber(s, rows.length),
          total: managerTotal === null ? "—" : formatNumber(s, managerTotal),
        });

  if (managerBusy) {
    return (
      <section className="px-4 py-5 sm:px-5" data-testid="web-sessions-busy">
        <SectionHeading level={2} variant="standard"
          kicker={v.sessionsKicker}
          title={s.details.pages.web.sessions}
          meta={v.managerBusy}
        />
        <div className="mt-5 rounded-xl border border-dashed border-border px-4 py-10 text-center">
          <IconWarning className="mx-auto text-warn" />
          <h3 className="mt-3 text-h3 font-semibold text-text">{v.sessionsBusyTitle}</h3>
          <p className="mx-auto mt-2 max-w-prose text-meta text-text-muted">{v.sessionsBusyText}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 rounded-lg border border-border px-4 py-2 text-meta font-semibold text-text hover:border-accent hover:text-accent"
          >
            {v.retry}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="px-4 py-5 sm:px-5" data-testid="web-sessions">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <SectionHeading level={2} variant="standard" kicker={v.sessionsKicker} title={s.details.pages.web.sessions} description={`${loadedLabel} ${v.boundedScan}`} />
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!bulkIntent || closePending || !canClose}
            onClick={() => bulkIntent && onIntent(bulkIntent)}
            className="rounded-lg border border-error/45 bg-error/10 px-3 py-2 text-micro font-semibold text-error-text disabled:cursor-not-allowed disabled:opacity-40"
            title={
              filtered.length > WEB_CLOSE_MAX_REFS
                ? fill(s.details.pages.web.closeTooManyTemplate, {
                    count: formatNumber(s, filtered.length),
                    max: formatNumber(s, WEB_CLOSE_MAX_REFS),
                  })
                : undefined
            }
          >
            {fill(v.closeFoundTemplate, { count: formatNumber(s, filtered.length) })}
          </button>
          <button
            type="button"
            disabled={closePending || !canClose || issuanceEnabled}
            onClick={() => onIntent({ kind: "all" })}
            className="rounded-lg border border-border px-3 py-2 text-micro font-semibold text-text-muted disabled:cursor-not-allowed disabled:opacity-40"
            title={issuanceEnabled ? s.details.pages.web.closeAllBlocked : undefined}
          >
            {s.details.pages.web.closeAll}
          </button>
        </div>
      </header>

      <div className="mt-4 grid divide-y divide-border rounded-xl border border-border bg-surface-2 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {[
          [v.byState, breakdown(stateCounts)],
          [v.byCarrier, breakdown(carrierCounts)],
          [
            v.scan,
            `${fill(v.scannedTemplate, { count: formatNumber(s, payload.sessions?.scanned ?? 0) })} · ${payload.sessions?.scan_truncated ? v.truncated : v.notTruncated}`,
          ],
        ].map(([label, value]) => (
          <div key={label} className="px-3 py-3">
            <span className="text-micro text-text-muted">{label}</span>
            <strong className="mt-1 block text-micro leading-relaxed text-text">{value}</strong>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-col gap-3">
        <div
          className="flex gap-1 overflow-x-auto"
          role="group"
          aria-label={s.details.pages.web.filterState}
        >
          {(
            [
              ...["all", v.all],
              ["healthy", "Healthy"],
              ["provisional", v.provisional],
              ["https-lanes", v.httpsLanes],
              ["websocket", v.websocket],
            ] as Array<[WebSessionFilter, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => {
                setFilter(key);
                setVisibleLimit(SESSION_REVEAL_SIZE);
              }}
              className={cn(
                "shrink-0 rounded-lg border px-3 py-2 text-micro font-semibold",
                filter === key
                  ? "border-accent bg-accent/15 text-accent"
                  : "border-border bg-surface-2 text-text-muted",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setVisibleLimit(SESSION_REVEAL_SIZE);
          }}
          placeholder={v.searchPlaceholder}
          aria-label={v.searchLabel}
          className="h-10 w-full rounded-lg border border-border bg-surface-2 px-3 text-meta text-text outline-none placeholder:text-text-faint focus:border-accent"
        />
      </div>

      <div
        className="mt-4 hidden grid-cols-[1.1fr_1fr_0.7fr_1.15fr_1fr] gap-3 border-y border-border px-3 py-2 text-label font-semibold uppercase tracking-wide text-text-muted lg:grid"
        aria-hidden="true"
      >
        <span>{v.stateUser}</span>
        <span>{v.route}</span>
        <span>{v.activity}</span>
        <span>{v.load}</span>
        <span>{v.client}</span>
      </div>
      <div className="border-t border-border lg:border-t-0">
        {pending && rows.length === 0 ? (
          <div className="px-4 py-12 text-center text-meta text-text-muted">
            {v.loadingSessions}
          </div>
        ) : error && rows.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-meta text-error-text">{v.sessionsError}</p>
            <button
              type="button"
              onClick={onRetry}
              className="mt-3 rounded-lg border border-border px-4 py-2 text-meta text-text"
            >
              {v.retry}
            </button>
          </div>
        ) : visible.length > 0 ? (
          visible.map((row) => (
            <SessionRow
              key={row.session_ref}
              row={row}
              s={s}
              onOpen={() => onOpenSession(row)}
            />
          ))
        ) : (
          <div className="px-4 py-12 text-center">
            <strong className="block text-h3 text-text">{v.noMatches}</strong>
            <span className="mt-1 block text-meta text-text-muted">{v.changeSearch}</span>
          </div>
        )}
      </div>
      {visible.length < filtered.length && (
        <button
          type="button"
          onClick={() => setVisibleLimit((current) => current + SESSION_REVEAL_SIZE)}
          className="mt-3 w-full rounded-xl border border-border bg-surface-2 px-4 py-3 text-meta font-semibold text-text hover:border-accent hover:text-accent"
        >
          {fill(v.showMoreTemplate, { count: formatNumber(s, filtered.length - visible.length) })}
        </button>
      )}
      <footer className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <span className="text-micro text-text-muted">{v.loadedRowsOnly}</span>
        {(hasMore || fetchingMore) && (
          <button
            type="button"
            disabled={fetchingMore}
            onClick={onLoadMore}
            className="rounded-lg border border-border px-4 py-2 text-meta font-semibold text-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            {fetchingMore ? v.loadingSessions : v.loadNext}
          </button>
        )}
      </footer>
    </section>
  );
}
