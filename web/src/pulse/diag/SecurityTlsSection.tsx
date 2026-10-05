import { useMemo, useState, type RefObject } from "react";
import { fill, formatNumber, useStrings } from "../../i18n";
import type { TlsFingerprintRow, TlsFingerprints } from "../../lib/api/generated/types.gen";
import { cn } from "../../lib/cn";
import { GatedNote } from "../GatedNote";
import { type SourceState } from "../sourceState";
import { duration, filterTlsRows, tlsRowIdentity, tlsRowSecondary, tlsTotals, tlsSeenAt, type SecurityTlsScope } from "./security.view.helpers";
import { SectionHeading } from "./SectionHeading";
import { formatRaw } from "../formatting";
import { SecuritySourceNotice as SourceNotice } from "./SecuritySourceNotice";
export function TlsPanel({
  tls,
  source,
  onRetry,
  scope,
  suspiciousOnly,
  onScopeChange,
  onFilterChange,
  resultsRef,
}: {
  tls: TlsFingerprints | undefined;
  source: SourceState | undefined;
  onRetry: () => void;
  scope: SecurityTlsScope;
  suspiciousOnly: boolean;
  onScopeChange: (scope: SecurityTlsScope) => void;
  onFilterChange: (value: boolean) => void;
  resultsRef: RefObject<HTMLHeadingElement | null>;
}) {
  const s = useStrings();
  const v = s.details.pages.security.view;
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(5);
  const rows = useMemo(() => filterTlsRows(tls?.[scope] ?? [], scope, query, suspiciousOnly), [query, scope, tls, suspiciousOnly]);
  const totals = tlsTotals(tls?.by_fingerprint);
  if (!tls) {
    if (source?.status === "disabled" || source?.status === "unsupported")
      return (
        <div className="p-5">
          <GatedNote
            reason={source.reason}
            variant={source.status === "unsupported" ? "unsupported" : "disabled"}
            hint={source.status === "unsupported" ? "telemt_outdated" : "runtime_edge"}
          />
        </div>
      );
    return (
      <SourceNotice kind={source?.status === "error" ? "error" : "loading"} onRetry={onRetry} />
    );
  }
  const max = Math.max(...rows.map((row) => suspiciousOnly ? row.bad_or_probe : row.total), 1);
  const scopes: Array<[SecurityTlsScope, string]> = [
    ["by_fingerprint", v.fingerprints],
    ["by_ip", "IP"],
    ["by_cidr", v.subnets],
    ["by_user", v.users],
  ];
  return (
    <section className="p-4 sm:p-5" data-testid="security-tls-panel">
      <SectionHeading level={2} variant="standard"
        kicker={v.clientHelloWindow}
        title={v.captureState}
        meta={fill(v.retention, { value: duration(s, tls.retention_secs) })}
      />
      <p className="mt-3 text-meta leading-relaxed text-text-muted">{fill(v.aggregateHint, { limit: formatNumber(s, tls.limit) })}</p>
      <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border lg:grid-cols-4">
        <CaptureStat
          label={v.observations}
          value={formatRaw(totals.observed, s, { boolean: "raw" })}
          hint={v.fourDimensions}
        />
        <CaptureStat
          label={v.badOrProbe}
          value={formatRaw(totals.bad, s, { boolean: "raw" })}
          hint="bad_or_probe"
          warn={(totals.bad ?? 0) > 0}
        />
        <CaptureStat
          label={v.parseErrors}
          value={formatNumber(s, tls.parse_error_total)}
          hint="parse_error_total"
          warn={tls.parse_error_total > 0}
        />
        <CaptureStat
          label={v.evicted}
          value={formatNumber(s, tls.dropped_total)}
          hint={fill(v.bufferCapacity, { count: formatNumber(s, tls.capacity) })}
          warn={tls.dropped_total > 0}
        />
      </div>
      <div className="mt-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex gap-1 overflow-x-auto" role="tablist" aria-label={v.tlsDimensions}>
          {scopes.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={scope === id}
              onClick={() => {
                onScopeChange(id);
                setVisible(5);
              }}
              className={cn(
                "shrink-0 rounded-lg px-3 py-2 text-meta font-semibold",
                scope === id
                  ? "bg-accent/15 text-accent"
                  : "text-text-muted hover:bg-surface-hover",
              )}
            >
              {label}
              <b className="ml-2 tabular-nums">{formatNumber(s, tls[id].length)}</b>
            </button>
          ))}
        </div>
        <label className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2 lg:w-72">
          <span className="text-text-faint" aria-hidden="true">
            ⌕
          </span>
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setVisible(5);
            }}
            className="min-w-0 flex-1 bg-transparent text-meta text-text outline-none placeholder:text-text-faint"
            placeholder={v.searchPlaceholder}
            aria-label={v.searchLabel}
          />
        </label>
      </div>
      <label className="mt-3 flex min-h-11 w-fit cursor-pointer items-center gap-2 text-meta text-text">
        <input type="checkbox" checked={suspiciousOnly} onChange={(event) => { onFilterChange(event.target.checked); setVisible(5); }} className="h-4 w-4 accent-accent" />
        {v.suspiciousOnly}
      </label>
      <div className="mt-5 flex flex-wrap items-end justify-between gap-2">
        <div>
          <span className="text-micro font-semibold uppercase tracking-[0.16em] text-text-faint">
            {v.ranking}
          </span>
          <h3 ref={resultsRef} tabIndex={-1} className="mt-1 text-h2 font-semibold text-text focus-visible:outline-2 focus-visible:outline-accent">
            {scopes.find(([id]) => id === scope)?.[1]}
          </h3>
        </div>
        <span className="text-meta text-text-muted">{suspiciousOnly ? v.sortedBySignals : v.sortedByTotal}</span>
      </div>
      <div className="mt-3 space-y-px overflow-hidden rounded-xl border border-border bg-border">
        {rows.slice(0, visible).map((row, index) => (
          <TlsRow
            key={`${tlsRowIdentity(row, scope)}-${row.ja3}-${index}`}
            row={row}
            scope={scope}
            index={index}
            max={max}
            suspiciousOnly={suspiciousOnly}
          />
        ))}
        {rows.length === 0 && (
          <div className="bg-surface px-4 py-10 text-center text-meta text-text-muted">
            {suspiciousOnly ? v.noSuspiciousMatches : v.noMatches}
          </div>
        )}
      </div>
      <footer className="mt-3 flex flex-wrap items-center justify-between gap-2 text-micro text-text-muted">
        <span>
          {fill(v.rowsShown, {
            visible: formatNumber(s, Math.min(visible, rows.length)),
            total: formatNumber(s, rows.length),
          })}
        </span>
        {visible < rows.length && (
          <button
            type="button"
            className="rounded-lg border border-border px-3 py-2 font-semibold text-text hover:border-accent/45"
            onClick={() => setVisible((value) => value + 10)}
          >
            {v.showMore}
          </button>
        )}
      </footer>
    </section>
  );
}

function CaptureStat({
  label,
  value,
  hint,
  warn = false,
}: {
  label: string;
  value: string;
  hint: string;
  warn?: boolean;
}) {
  return (
    <div className={cn("bg-surface px-4 py-3", warn && "bg-warn/5")}>
      <span className="block text-micro text-text-faint">{label}</span>
      <strong
        className={cn(
          "mt-1 block text-xl font-bold tabular-nums text-text",
          warn && "text-warn",
        )}
      >
        {value}
      </strong>
      <small className="mt-1 block text-micro text-text-muted">{hint}</small>
    </div>
  );
}

function TlsRow({
  row,
  scope,
  index,
  max,
  suspiciousOnly,
}: {
  row: TlsFingerprintRow;
  scope: SecurityTlsScope;
  index: number;
  max: number;
  suspiciousOnly: boolean;
}) {
  const s = useStrings();
  const v = s.details.pages.security.view;
  return (
    <div
      className={cn(
        "grid gap-3 bg-surface px-3 py-3 sm:grid-cols-[2rem_minmax(0,1fr)_minmax(110px,.5fr)_5.5rem] sm:items-center",
        row.bad_or_probe > 0 && "bg-gradient-to-r from-warn/10 to-surface",
      )}
      data-security-row={row.bad_or_probe > 0 ? "warn" : "ok"}
    >
      <span className="hidden text-center text-micro tabular-nums text-text-faint sm:block">
        {index + 1}
      </span>
      <div className="min-w-0">
        <strong
          className="block truncate text-meta font-semibold text-text"
          title={tlsRowIdentity(row, scope)}
        >
          {tlsRowIdentity(row, scope)}
        </strong>
        <span
          className="mt-1 block truncate font-mono text-micro text-text-faint"
          title={tlsRowSecondary(row, scope)}
        >
          {tlsRowSecondary(row, scope)}
        </span>
        <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-meta text-text-muted">
          <div><dt className="inline">{v.firstSeen}: </dt><dd className="inline">{tlsSeenAt(s, row.first_seen_epoch_secs)}</dd></div>
          <div><dt className="inline">{v.lastSeen}: </dt><dd className="inline">{tlsSeenAt(s, row.last_seen_epoch_secs)}</dd></div>
        </dl>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-bg ring-1 ring-inset ring-border">
        <i
          className={cn(
            "block h-full rounded-full bg-gradient-to-r",
            row.bad_or_probe > 0 ? "from-warn/60 to-warn" : "from-accent/60 to-accent",
          )}
          style={{ width: `${Math.max(2, ((suspiciousOnly ? row.bad_or_probe : row.total) / max) * 100)}%` }}
        />
      </div>
      <div className="flex items-end justify-between gap-3 sm:block sm:text-right">
        <strong className="text-base font-bold tabular-nums text-text">
          {formatNumber(s, suspiciousOnly ? row.bad_or_probe : row.total)}
        </strong>
        <span
          className={cn(
            "block text-micro",
            row.bad_or_probe > 0 ? "text-warn" : "text-text-faint",
          )}
        >
          {suspiciousOnly
            ? fill(v.totalObserved, { count: formatNumber(s, row.total) })
            : row.bad_or_probe > 0
            ? fill(v.needReview, { count: formatNumber(s, row.bad_or_probe) })
            : v.noSignals}
        </span>
      </div>
    </div>
  );
}
