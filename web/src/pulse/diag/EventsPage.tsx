import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { fill, formatNumber, localeOf, useStrings, type Dict } from "../../i18n";
import { cn } from "../../lib/cn";
import { formatDurationApprox } from "../../people/expiry";
import { useNow } from "../../people/useNow";
import { useSnapshot } from "../../realtime";
import type {
  RuntimeEdgeEventRecord,
  RuntimeEdgeEvents,
  RuntimeTopic,
} from "../../realtime/topics";
import { IconChevronDown } from "../../ui/icons";
import { DetailHeader } from "../details-builder/DetailHeader";
import {
  EVENT_FAMILY_OTHER,
  eventFamily,
  eventTypeCount,
  eventsPageDefinition,
  orderedEvents,
} from "../details-builder/definitions/events";
import { useDetailSources, type DetailSourceInput } from "../details-builder/sources";
import {
  eventAgo,
  eventLine,
  eventTime,
  eventTimestamp,
  eventTone,
  type EventTone,
} from "../widgets/recentEvents.helpers";
import { resolveGated } from "../widgets/gated";

type EventFamilyFilter = "all" | "admission" | "config" | "api" | "other";

function SectionHeading({ kicker, title, meta }: { kicker: string; title: string; meta?: string }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div>
        <span className="text-label font-semibold uppercase tracking-[0.12em] text-text-muted">
          {kicker}
        </span>
        <h3 className="mt-1 text-h3 font-semibold text-text">{title}</h3>
      </div>
      {meta && <span className="text-micro text-text-muted">{meta}</span>}
    </header>
  );
}

function familyLabel(family: EventFamilyFilter, s: Dict): string {
  const v = s.details.pages.events.view;
  return {
    all: v.all,
    admission: v.admission,
    config: v.config,
    api: v.api,
    other: v.other,
  }[family];
}

function familyColor(family: string): string {
  if (family === "admission") return "bg-[#58aee8]";
  if (family === "config") return "bg-[#9c7fe8]";
  if (family === "api") return "bg-warn";
  return "bg-border-strong";
}

function toneClasses(tone: EventTone): { border: string; dot: string } {
  if (tone === "error") return { border: "border-error/45", dot: "border-error bg-error" };
  if (tone === "warn") return { border: "border-warn/45", dot: "border-warn bg-warn" };
  if (tone === "ok") return { border: "border-ok/35", dot: "border-ok bg-ok" };
  return { border: "border-border", dot: "border-accent bg-accent" };
}

function contextParts(context: string): Array<[string, string]> {
  const matches = [...context.matchAll(/([a-zA-Z0-9_./-]+)=([^\s]+)/g)].map(
    (match) => [match[1]!, match[2]!] as [string, string],
  );
  if (matches.length > 0) return matches;
  return context.trim() ? [["context", context.trim()]] : [];
}

function historyRange(events: readonly RuntimeEdgeEventRecord[], s: Dict): string {
  if (events.length < 2) return s.details.pages.events.view.noHistory;
  const newest = events[0]!.ts_epoch_secs;
  const oldest = events.at(-1)!.ts_epoch_secs;
  return formatDurationApprox(Math.max(0, newest - oldest) * 1_000, s);
}

function Summary({
  events,
  buffer,
  nowMs,
  s,
}: {
  events: RuntimeEdgeEventRecord[];
  buffer: RuntimeEdgeEvents;
  nowMs: number;
  s: Dict;
}) {
  const v = s.details.pages.events.view;
  const latest = events[0];
  const latestLine = latest ? eventLine(latest, s) : null;
  const vitals = [
    [
      v.stored,
      `${formatNumber(s, events.length)} / ${formatNumber(s, buffer.capacity)}`,
      v.storedNote,
    ],
    [v.historyPeriod, historyRange(events, s), v.historyNote],
    [v.eventTypes, formatNumber(s, eventTypeCount(events) ?? 0), v.typesNote],
  ];
  return (
    <section
      className="grid border-b border-border sm:grid-cols-3 xl:grid-cols-[minmax(360px,1.45fr)_repeat(3,minmax(150px,.55fr))]"
      data-testid="events-summary"
    >
      <div className="min-h-32 border-b border-r border-border px-4 py-5 sm:col-span-3 sm:px-5 xl:col-span-1">
        <span className="text-label font-semibold uppercase tracking-[0.12em] text-text-muted">
          {v.latestEvent}
        </span>
        <h3 className="mt-2 text-h3 font-semibold text-text">{latestLine?.text ?? v.noEvents}</h3>
        <p className="mt-2 text-micro leading-relaxed text-text-muted">
          {latest
            ? `${eventAgo(latest.ts_epoch_secs, nowMs, s)} · ${latest.event_type}`
            : v.bufferReady}
        </p>
      </div>
      {vitals.map(([label, value, note]) => (
        <div
          key={label}
          className="flex min-h-28 min-w-0 flex-col justify-center border-b border-r border-border px-4 py-4"
        >
          <span className="text-micro text-text-muted">{label}</span>
          <strong className="mt-2 break-all font-mono text-h3 font-bold tabular-nums text-text">
            {value}
          </strong>
          <small className="mt-1 text-micro leading-relaxed text-text-muted">{note}</small>
        </div>
      ))}
    </section>
  );
}

function TimelineRow({
  event,
  nowMs,
  s,
}: {
  event: RuntimeEdgeEventRecord;
  nowMs: number;
  s: Dict;
}) {
  const line = eventLine(event, s);
  const family = eventFamily(event.event_type);
  const tone = eventTone(event.event_type);
  const colors = toneClasses(tone);
  const parts = contextParts(event.context);
  return (
    <article
      className="grid grid-cols-[54px_14px_minmax(0,1fr)] items-stretch gap-x-2 sm:grid-cols-[72px_18px_minmax(0,1fr)] sm:gap-x-3"
      data-event-row={event.seq}
      data-event-family-row={family}
      data-event-tone={tone}
    >
      <div className="pt-3 text-right">
        <strong className="block font-mono text-micro font-bold tabular-nums text-text">
          {eventTime(event.ts_epoch_secs, s)}
        </strong>
        <span className="mt-1 block text-micro leading-tight text-text-muted">
          {eventAgo(event.ts_epoch_secs, nowMs, s)}
        </span>
      </div>
      <div className="relative flex justify-center">
        <i className="absolute inset-y-0 w-px bg-border" />
        <i
          className={cn(
            "relative mt-4 h-3 w-3 rounded-full border-2 ring-4 ring-surface",
            colors.dot,
          )}
        />
      </div>
      <div
        className={cn(
          "mb-3 min-w-0 rounded-xl border bg-surface-2 px-3 py-3 sm:px-4",
          colors.border,
        )}
      >
        <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <span className="text-label font-semibold uppercase tracking-[0.1em] text-text-muted">
              {familyLabel(
                (family === EVENT_FAMILY_OTHER ? "other" : family) as EventFamilyFilter,
                s,
              )}
            </span>
            <h4 className="mt-1 text-meta font-semibold text-text">{line.text}</h4>
          </div>
          <code className="max-w-full break-all font-mono text-micro text-text-muted sm:max-w-[45%] sm:text-right">
            {event.event_type}
          </code>
        </header>
        {parts.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {parts.map(([key, value], index) => (
              <span
                key={`${key}-${index}`}
                className="min-w-0 rounded-md border border-border bg-surface px-2 py-1 text-micro text-text-muted"
              >
                <b className="mr-1 font-mono font-semibold text-text">{key}</b>
                <span className="break-all">{value}</span>
              </span>
            ))}
          </div>
        )}
        <footer className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 font-mono text-micro tabular-nums text-text-muted">
          <span>seq {formatNumber(s, event.seq)}</span>
          <time dateTime={new Date(event.ts_epoch_secs * 1_000).toISOString()}>
            {eventTimestamp(event.ts_epoch_secs, s)}
          </time>
        </footer>
      </div>
    </article>
  );
}

function Timeline({
  events,
  nowMs,
  s,
}: {
  events: RuntimeEdgeEventRecord[];
  nowMs: number;
  s: Dict;
}) {
  const v = s.details.pages.events.view;
  const [family, setFamily] = useState<EventFamilyFilter>("all");
  const [query, setQuery] = useState("");
  const [visibleLimit, setVisibleLimit] = useState(8);
  const counts = useMemo(() => {
    const result: Record<EventFamilyFilter, number> = {
      all: events.length,
      admission: 0,
      config: 0,
      api: 0,
      other: 0,
    };
    for (const event of events) {
      const value = eventFamily(event.event_type);
      const key = value === EVENT_FAMILY_OTHER ? "other" : (value as EventFamilyFilter);
      result[key] += 1;
    }
    return result;
  }, [events]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return events.filter((event) => {
      const current = eventFamily(event.event_type);
      if (family !== "all" && current !== family) return false;
      if (!needle) return true;
      const line = eventLine(event, s);
      return `${event.event_type} ${event.context} ${line.text}`.toLowerCase().includes(needle);
    });
  }, [events, family, query, s]);
  const visible = filtered.slice(0, visibleLimit);
  const families = (["all", "admission", "config", "api", "other"] as EventFamilyFilter[]).filter(
    (item) => item === "all" || counts[item] > 0,
  );
  const caption =
    query || family !== "all"
      ? fill(v.foundTemplate, { count: formatNumber(s, filtered.length) })
      : fill(v.lastTemplate, {
          shown: formatNumber(s, Math.min(visibleLimit, filtered.length)),
          total: formatNumber(s, events.length),
        });

  return (
    <section className="min-w-0 px-4 py-5 sm:px-5" data-testid="events-timeline">
      <SectionHeading kicker={v.newestFirst} title={v.timeline} meta={caption} />
      <div className="mt-4 flex flex-col gap-3">
        <div
          className="flex gap-1 overflow-x-auto"
          role="group"
          aria-label={s.details.pages.events.filterFamily}
        >
          {families.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={family === item}
              onClick={() => {
                setFamily(item);
                setVisibleLimit(8);
              }}
              className={cn(
                "shrink-0 rounded-lg border px-3 py-2 text-micro font-semibold",
                family === item
                  ? "border-accent bg-accent/15 text-accent"
                  : "border-border bg-surface-2 text-text-muted",
              )}
            >
              {familyLabel(item, s)}{" "}
              <b className="ml-1 tabular-nums">{formatNumber(s, counts[item])}</b>
            </button>
          ))}
        </div>
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setVisibleLimit(8);
          }}
          placeholder={v.searchPlaceholder}
          aria-label={v.searchLabel}
          className="h-10 w-full rounded-lg border border-border bg-surface-2 px-3 text-meta text-text outline-none placeholder:text-text-faint focus:border-accent"
        />
      </div>
      <div className="mt-5">
        {visible.map((event) => (
          <TimelineRow key={event.seq} event={event} nowMs={nowMs} s={s} />
        ))}
        {visible.length === 0 && (
          <div className="rounded-xl border border-dashed border-border px-4 py-12 text-center">
            <span className="text-h2 text-text-muted">○</span>
            <h4 className="mt-2 text-h3 font-semibold text-text">
              {events.length > 0 ? v.nothingFound : v.noEvents}
            </h4>
            <p className="mt-1 text-meta text-text-muted">
              {events.length > 0 ? v.changeFilter : v.newEventsAppear}
            </p>
          </div>
        )}
      </div>
      {visible.length < filtered.length && (
        <button
          type="button"
          onClick={() => setVisibleLimit((current) => current + 8)}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-surface-2 px-4 py-3 text-meta font-semibold text-text hover:border-accent hover:text-accent"
        >
          {s.details.collection.showMore}
          <span className="text-micro tabular-nums text-text-muted">
            {formatNumber(s, filtered.length - visible.length)}
          </span>
        </button>
      )}
    </section>
  );
}

function Analysis({
  events,
  buffer,
  s,
}: {
  events: RuntimeEdgeEventRecord[];
  buffer: RuntimeEdgeEvents;
  s: Dict;
}) {
  const v = s.details.pages.events.view;
  const counts = new Map<string, number>();
  for (const event of events) {
    const family = eventFamily(event.event_type);
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  const composition = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const fillPercent =
    buffer.capacity > 0 ? Math.min(100, (events.length / buffer.capacity) * 100) : 0;
  const admissionDominates = (counts.get("admission") ?? 0) > events.length * 0.8;
  return (
    <aside
      className="border-t border-border xl:border-l xl:border-t-0"
      data-testid="events-analysis"
    >
      <section className="border-b border-border px-4 py-5 sm:px-5">
        <SectionHeading kicker={v.composition} title={v.dominates} />
        <div className="mt-5 space-y-4">
          {composition.map(([family, count]) => {
            const percent = events.length > 0 ? (count / events.length) * 100 : 0;
            return (
              <div key={family} data-event-composition={family}>
                <div className="flex items-center justify-between gap-3 text-meta">
                  <span className="text-text-muted">
                    {familyLabel(
                      (family === EVENT_FAMILY_OTHER ? "other" : family) as EventFamilyFilter,
                      s,
                    )}
                  </span>
                  <strong className="font-mono tabular-nums text-text">
                    {formatNumber(s, count)}
                  </strong>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-3">
                    <i
                      className={cn("block h-full rounded-full", familyColor(family))}
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                  <small className="w-12 text-right text-micro tabular-nums text-text-muted">
                    {new Intl.NumberFormat(localeOf(s), { maximumFractionDigits: 1 }).format(
                      percent,
                    )}
                    %
                  </small>
                </div>
              </div>
            );
          })}
          {composition.length === 0 && (
            <p className="text-meta text-text-muted">{v.compositionEmpty}</p>
          )}
        </div>
        {admissionDominates && (
          <p className="mt-5 flex gap-2 rounded-xl border border-border bg-surface-2 px-3 py-3 text-micro leading-relaxed text-text-muted">
            <span className="text-accent">i</span>
            <span>{v.admissionDominates}</span>
          </p>
        )}
      </section>
      <section className="px-4 py-5 sm:px-5">
        <SectionHeading kicker={v.ringBuffer} title={v.historyBoundary} />
        <div className="mt-5 flex items-baseline justify-between gap-3">
          <strong className="font-mono text-h2 font-bold tabular-nums text-text">
            {formatNumber(s, events.length)} / {formatNumber(s, buffer.capacity)}
          </strong>
          <span className="text-micro text-text-muted">
            {new Intl.NumberFormat(localeOf(s), { maximumFractionDigits: 0 }).format(fillPercent)}%{" "}
            {v.occupied}
          </span>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-3">
          <i className="block h-full rounded-full bg-accent" style={{ width: `${fillPercent}%` }} />
        </div>
        <div className="mt-5 flex items-center justify-between gap-4 border-y border-border py-3">
          <span className="text-meta text-text-muted">{v.evicted}</span>
          <strong className="font-mono text-h3 font-bold tabular-nums text-text">
            {formatNumber(s, buffer.dropped_total)}
          </strong>
        </div>
        <p className="mt-4 text-micro leading-relaxed text-text-muted">
          {buffer.dropped_total > 0 ? v.evictionExplanation : v.bufferNotReached}
        </p>
      </section>
    </aside>
  );
}

function DisabledPanel({ reason, s }: { reason: string; s: Dict }) {
  const v = s.details.pages.events.view;
  return (
    <section className="px-4 py-5 sm:px-5" data-testid="events-disabled">
      <div className="grid gap-4 rounded-xl border border-border bg-surface-2 px-4 py-5 sm:grid-cols-[48px_minmax(0,1fr)] sm:px-5">
        <span className="grid h-12 w-12 place-items-center rounded-xl border border-border-strong bg-surface-3 text-h3 text-text-muted">
          i
        </span>
        <div>
          <span className="text-label font-semibold uppercase tracking-[0.12em] text-text-muted">
            {reason || v.disabledKicker}
          </span>
          <h3 className="mt-1 text-h2 font-semibold text-text">{v.journalDisabled}</h3>
          <p className="mt-2 max-w-3xl text-meta leading-relaxed text-text-muted">
            {v.disabledDescription}
          </p>
          <ul className="mt-4 grid gap-2 text-meta text-text-muted">
            {[v.disabledObservability, v.enableRuntimeEdge, v.logsSeparate].map((item) => (
              <li key={item} className="flex gap-2">
                <span className="text-accent">•</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Technical({
  data,
  enabled,
  reason,
  s,
}: {
  data: RuntimeEdgeEvents | null;
  enabled: boolean | null;
  reason?: string;
  s: Dict;
}) {
  const v = s.details.pages.events.view;
  const ordered = data ? orderedEvents(data.events) : [];
  const rows: Array<[string, string]> = data
    ? [
        ["request", "/v1/runtime/events/recent?limit=50"],
        ["enabled", String(enabled ?? true)],
        ["capacity", formatNumber(s, data.capacity)],
        ["dropped_total", formatNumber(s, data.dropped_total)],
        ["events.length", formatNumber(s, data.events.length)],
        ["latest_seq", ordered[0] ? formatNumber(s, ordered[0].seq) : "—"],
        ["oldest_seq", ordered.at(-1) ? formatNumber(s, ordered.at(-1)!.seq) : "—"],
      ]
    : [
        ["source", "/v1/runtime/events/recent"],
        ["enabled", String(enabled ?? false)],
        ["reason", reason ?? "feature_disabled"],
      ];
  return (
    <details
      className="group border-t border-border px-4 py-4 sm:px-5"
      data-testid="events-technical"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <span>
          <strong className="block text-meta text-text">{v.technical}</strong>
          <span className="block text-micro text-text-muted">{v.technicalDescription}</span>
        </span>
        <IconChevronDown className="shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <dl className="mt-4 grid border-t border-border sm:grid-cols-2 xl:grid-cols-4">
        {rows.map(([label, value]) => (
          <div key={label} className="min-w-0 border-b border-r border-border px-3 py-3">
            <dt className="truncate font-mono text-micro text-text-muted" title={label}>
              {label}
            </dt>
            <dd className="mt-1 break-all text-meta font-semibold tabular-nums text-text">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function EventsPage() {
  const runtime = useSnapshot<RuntimeTopic>("runtime");
  const navigate = useNavigate();
  const s = useStrings();
  const nowMs = useNow(1_000);
  const gate = runtime.data?.recent_events ?? null;
  const resolved = gate ? resolveGated(gate) : null;
  const data = resolved?.status === "ok" ? resolved.data : null;
  const ordered = useMemo(() => orderedEvents(data?.events), [data?.events]);
  const inputs: Record<string, DetailSourceInput> = {
    events: { kind: "topic", snapshot: runtime, gated: gate },
  };
  const sources = useDetailSources(eventsPageDefinition.sources, inputs);
  const disabled = runtime.data !== null && data === null;
  const status = disabled ? "disabled" : sources.status;

  return (
    <div className="w-full" data-testid="events-detail">
      <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        <div className="border-b border-border px-4 py-4 sm:px-5">
          <DetailHeader
            title={s.details.pages.events.title}
            description={s.details.pages.events.description}
            status={status}
            freshnessMs={sources.freshnessMs}
            nowMs={nowMs}
            onBack={() => void navigate({ to: "/pulse" })}
          />
        </div>
        {runtime.data === null ? (
          <div className="grid min-h-64 place-items-center px-5 text-center">
            <div>
              <p className="text-h3 font-semibold text-text">
                {s.details.pages.events.view.loading}
              </p>
              <p className="mt-1 text-meta text-text-muted">
                {runtime.error ?? s.details.pages.events.view.loadingDescription}
              </p>
            </div>
          </div>
        ) : disabled ? (
          <DisabledPanel
            reason={
              resolved?.status === "gated"
                ? (resolved.reason ?? "feature_disabled")
                : "feature_disabled"
            }
            s={s}
          />
        ) : data ? (
          <>
            <Summary events={ordered} buffer={data} nowMs={nowMs} s={s} />
            <div className="grid xl:grid-cols-[minmax(0,1.55fr)_minmax(280px,.55fr)]">
              <Timeline events={ordered} nowMs={nowMs} s={s} />
              <Analysis events={ordered} buffer={data} s={s} />
            </div>
          </>
        ) : null}
        {runtime.data && (
          <Technical data={data} enabled={gate?.enabled ?? null} reason={gate?.reason} s={s} />
        )}
      </section>
    </div>
  );
}
