import { useCallback, useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { fill, formatNumber, useStrings, type Dict } from "../../i18n";
import {
  closeTelemtWebSessionsMutation,
  getTelemtWebSessionsInfiniteOptions,
  getTelemtWebSessionsInfiniteQueryKey,
} from "../../lib/api/generated/@tanstack/react-query.gen";
import type { WebSessionPage, WebSessionRow } from "../../lib/api/generated/types.gen";
import { cn } from "../../lib/cn";
import { formatBytes } from "../../lib/format";
import { useTelemtOperation } from "../../lib/useTelemtOperation";
import { apiErrorMessage } from "../../people/apiError";
import { formatDurationApprox } from "../../people/expiry";
import { useNow } from "../../people/useNow";
import { useSnapshot } from "../../realtime";
import type { WebTopic } from "../../realtime/topics";
import { ConfirmView } from "../../ui/ConfirmView";
import { IconChevronDown, IconChevronRight, IconWarning } from "../../ui/icons";
import { pushToast } from "../../ui/Toast";
import { DetailHeader } from "../details-builder/DetailHeader";
import { AdaptiveDetailSurface } from "../details-builder/surfaces/AdaptiveDetailSurface";
import {
  WEB_FILTER_CARRIER,
  WEB_FILTER_STATE,
  webPageDefinition,
} from "../details-builder/definitions/web";
import type { FilterValue } from "../details-builder/model";
import { useDetailSources, type DetailSourceInput } from "../details-builder/sources";
import {
  WEB_CLOSE_MAX_REFS,
  webCloseIntent,
  webCloseSelector,
  webFilterSummary,
  webPagePayload,
  webRuntimeInstance,
  type CloseIntent,
  type WebPagePayload,
} from "./web.helpers";
import {
  webCapacityReadings,
  webHasCapacityPressure,
  webSessionMatches,
  webSessionStateTone,
  type WebCapacityReading,
  type WebSessionFilter,
} from "./web.view.helpers";
import { useWebCloseReport } from "./useWebCloseReport";

const SESSIONS_PAGE_SIZE = 20;
const SESSION_REVEAL_SIZE = 8;
const WEB_STATUS_SOURCE = "/v1/runtime/web/status";

function Kicker({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-label font-bold uppercase tracking-[0.13em] text-accent">{children}</span>
  );
}

function SectionHeading({ kicker, title, meta }: { kicker: string; title: string; meta?: string }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-2">
      <div>
        <Kicker>{kicker}</Kicker>
        <h3 className="mt-1 text-h2 font-semibold text-text">{title}</h3>
      </div>
      {meta && <span className="text-micro text-text-muted">{meta}</span>}
    </header>
  );
}

function Vital({
  label,
  value,
  note,
  tone = "neutral",
}: {
  label: string;
  value: string;
  note: string;
  tone?: "good" | "warn" | "bad" | "neutral";
}) {
  return (
    <div className="min-w-0 px-3 py-4 sm:px-4" data-web-vital={label}>
      <span className="block text-meta text-text-muted">{label}</span>
      <strong
        className={cn(
          "mt-1 block break-words text-h2 font-semibold tabular-nums",
          tone === "good"
            ? "text-ok"
            : tone === "warn"
              ? "text-warn"
              : tone === "bad"
                ? "text-error-text"
                : "text-text",
        )}
      >
        {value}
      </strong>
      <small className="mt-1 block text-micro leading-snug text-text-muted">{note}</small>
    </div>
  );
}

function CapacityRow({ reading, s }: { reading: WebCapacityReading; s: Dict }) {
  const v = s.details.pages.web.view;
  const labels: Record<WebCapacityReading["id"], string> = {
    sessions: v.capacitySessions,
    streams: v.capacityStreams,
    http: v.capacityHttp,
    queue: v.capacityQueue,
    websocket: v.capacityWebsocket,
  };
  const format = (value: number) =>
    reading.bytes ? formatBytes(value, s) : formatNumber(s, value);
  const value =
    reading.value === null || reading.limit === null
      ? v.managerBusy
      : `${format(reading.value)} / ${format(reading.limit)} · ${formatNumber(s, reading.percent ?? 0)}%`;
  return (
    <div className="py-2.5" data-web-capacity={reading.id} data-web-tone={reading.tone}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-meta">
        <strong className="text-text">{labels[reading.id]}</strong>
        <span className="tabular-nums text-text-muted">{value}</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-3">
        <i
          className={cn(
            "block h-full rounded-full transition-[width]",
            reading.tone === "bad"
              ? "bg-error"
              : reading.tone === "warn"
                ? "bg-warn"
                : reading.tone === "busy"
                  ? "w-full bg-text-faint/20"
                  : "bg-accent",
          )}
          style={{ width: reading.percent === null ? undefined : `${reading.percent}%` }}
        />
      </div>
    </div>
  );
}

function ContextBanner({ payload, s }: { payload: WebPagePayload; s: Dict }) {
  const v = s.details.pages.web.view;
  const runtime = payload.runtime;
  const sessions = runtime?.manager?.sessions ?? 0;
  if (payload.lifecycle === "draining") {
    return (
      <div className="border-b border-warn/40 bg-warn-soft/10 px-4 py-3 sm:px-5">
        <strong className="block text-meta text-warn">{v.drainingTitle}</strong>
        <span className="mt-1 block text-meta text-text-muted">
          {fill(v.drainingTextTemplate, { count: formatNumber(s, sessions) })}
        </span>
      </div>
    );
  }
  if ((runtime?.partial.length ?? 0) > 0) {
    return (
      <div className="border-b border-border bg-surface-2 px-4 py-3 sm:px-5">
        <strong className="block text-meta text-text">{v.partialTitle}</strong>
        <span className="mt-1 block text-meta text-text-muted">
          {fill(v.partialTextTemplate, { planes: runtime!.partial.join(", ") })}
        </span>
      </div>
    );
  }
  if ((runtime?.limit_hits ?? 0) > 0) {
    return (
      <div className="border-b border-warn/40 bg-warn-soft/10 px-4 py-3 sm:px-5">
        <strong className="block text-meta text-warn">{v.pressureTitle}</strong>
        <span className="mt-1 block text-meta text-text-muted">
          {fill(v.pressureTextTemplate, { count: formatNumber(s, runtime!.limit_hits) })}
        </span>
      </div>
    );
  }
  return null;
}

export function Overview({ payload, s }: { payload: WebPagePayload; s: Dict }) {
  const v = s.details.pages.web.view;
  const runtime = payload.runtime;
  if (!runtime) return null;
  const manager = runtime.manager;
  const streams = runtime.streams;
  const readings = webCapacityReadings(payload);
  const sessionLimit = readings.find((reading) => reading.id === "sessions")?.limit;
  const streamLimit = readings.find((reading) => reading.id === "streams")?.limit;
  const issuance = manager?.issuance_enabled;
  const partial = runtime.partial;
  const learning = runtime.learning;
  const debug = runtime.debug;
  const debugEnabled = debug?.policy["enabled"] === true;
  const websocket = runtime.websockets;

  return (
    <div data-testid="web-overview">
      <ContextBanner payload={payload} s={s} />
      <section
        className="grid divide-x divide-y divide-border border-b border-border sm:grid-cols-2 xl:grid-cols-5 xl:divide-y-0"
        aria-label={s.details.pages.web.title}
        data-testid="web-vitals"
      >
        <Vital
          label={v.mode}
          value={payload.lifecycle === "draining" ? v.drainingMode : v.runningMode}
          note={fill(v.inStateTemplate, { age: formatDurationApprox(payload.lifecycle_age_ms, s) })}
          tone={payload.lifecycle === "draining" ? "warn" : "good"}
        />
        <Vital
          label={v.issuance}
          value={
            issuance === null || issuance === undefined
              ? "—"
              : issuance
                ? v.issuanceAllowed
                : v.issuanceStopped
          }
          note={
            issuance === null || issuance === undefined
              ? v.managerBusy
              : issuance
                ? v.issuanceAllowedNote
                : v.issuanceStoppedNote
          }
          tone={issuance === true ? "good" : issuance === false ? "warn" : "neutral"}
        />
        <Vital
          label={v.liveSessions}
          value={manager ? formatNumber(s, manager.sessions) : "—"}
          note={
            manager && sessionLimit !== null && sessionLimit !== undefined
              ? fill(v.limitTemplate, { value: formatNumber(s, sessionLimit) })
              : v.managerBusy
          }
        />
        <Vital
          label={v.liveStreams}
          value={streams ? formatNumber(s, streams.live) : "—"}
          note={
            streams && streamLimit !== null && streamLimit !== undefined
              ? fill(v.limitTemplate, { value: formatNumber(s, streamLimit) })
              : partial.includes("streams")
                ? v.managerBusy
                : "—"
          }
        />
        <Vital
          label={v.limitHits}
          value={formatNumber(s, runtime.limit_hits)}
          note={runtime.limit_hits > 0 ? v.sinceStart : v.noLimitHits}
          tone={runtime.limit_hits > 0 ? "warn" : "good"}
        />
      </section>

      <div className="grid border-b border-border xl:grid-cols-[minmax(0,1.7fr)_minmax(280px,0.8fr)]">
        <section
          className="px-4 py-5 sm:px-5 xl:border-r xl:border-border"
          data-testid="web-capacity"
        >
          <SectionHeading kicker={v.capacityKicker} title={v.capacityTitle} meta={v.usedLimit} />
          <div className="mt-3">
            {readings.map((reading) => (
              <CapacityRow key={reading.id} reading={reading} s={s} />
            ))}
          </div>
          <p className="mt-2 border-t border-border pt-3 text-micro leading-relaxed text-text-muted">
            {v.capacityNote}
          </p>
        </section>

        <section className="px-4 py-5 sm:px-5" data-testid="web-runtime">
          <SectionHeading kicker={v.runtimeKicker} title={v.runtimeTitle} />
          <dl className="mt-4 divide-y divide-border border-y border-border">
            {[
              [v.configuration, payload.effective_config_enabled ? v.webEnabled : v.webDisabled],
              [v.listener, payload.listeners.length > 0 ? payload.listeners.join(" · ") : "—"],
              [
                v.carrierLearning,
                learning === null
                  ? v.managerBusy
                  : learning?.enabled
                    ? `${v.enabled} · ${learning.aggressiveness}`
                    : v.disabled,
              ],
              [
                v.debugCapture,
                debug === null ? v.managerBusy : debugEnabled ? v.enabled : v.disabled,
              ],
            ].map(([label, value]) => (
              <div key={label} className="grid gap-1 py-3 sm:grid-cols-[120px_minmax(0,1fr)]">
                <dt className="text-meta text-text-muted">{label}</dt>
                <dd className="break-all font-mono text-meta font-semibold text-text">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      <section className="border-b border-border px-4 py-5 sm:px-5" data-testid="web-flow">
        <SectionHeading kicker={v.flowKicker} title={v.flowTitle} meta={v.notRealtime} />
        <div className="mt-4 grid divide-y divide-border border-y border-border sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-4">
          {[
            [
              v.streamsOpened,
              formatNumber(s, runtime.streams_opened),
              runtime.streams_rejected
                ? fill(v.rejectedTemplate, { count: formatNumber(s, runtime.streams_rejected) })
                : v.noRejections,
            ],
            [
              v.sessionsClosed,
              formatNumber(s, runtime.session_incarnations_closed),
              manager
                ? fill(v.remainLiveTemplate, { count: formatNumber(s, manager.sessions) })
                : v.registryUnavailable,
            ],
            [v.trafficUp, formatBytes(runtime.bytes_up, s), v.sinceRuntime],
            [v.trafficDown, formatBytes(runtime.bytes_down, s), v.sinceRuntime],
          ].map(([label, value, note]) => (
            <div key={label} className="px-3 py-4">
              <span className="block text-meta text-text-muted">{label}</span>
              <strong className="mt-1 block text-h2 font-semibold tabular-nums text-text">
                {value}
              </strong>
              <small className="mt-1 block text-micro text-text-muted">{note}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="px-4 py-5 sm:px-5" data-testid="web-planes">
        <SectionHeading kicker={v.planesKicker} title={v.planesTitle} meta={v.planesIndependent} />
        <div className="mt-4 grid divide-y divide-border border-y border-border lg:grid-cols-3 lg:divide-x lg:divide-y-0">
          <Plane
            mark="WS"
            title={v.websocketRegistry}
            busy={partial.includes("websockets")}
            text={
              websocket
                ? `${formatNumber(s, websocket.entries)} entries · ${formatNumber(s, websocket.claims)} claims · ${formatNumber(s, websocket.evictions_in_flight)} eviction`
                : v.managerBusy
            }
          />
          <Plane
            mark="CL"
            title={v.carrierLearningName}
            busy={partial.includes("learning")}
            text={
              learning
                ? `${formatNumber(s, learning.entries)} / ${formatNumber(s, learning.capacity)} evidence · ${learning.aggressiveness}`
                : v.managerBusy
            }
          />
          <Plane
            mark="DB"
            title={v.debugRecorder}
            busy={partial.includes("debug")}
            text={
              debug && debugEnabled
                ? `${formatNumber(s, debug.records)} / ${formatNumber(s, debug.records_capacity)} records · ${formatNumber(s, debug.contention_drops)} drops`
                : debug && debug.records > 0
                  ? `${v.disabled} · ${formatNumber(s, debug.records)} records`
                  : partial.includes("debug")
                    ? v.managerBusy
                    : v.captureOff
            }
          />
        </div>
      </section>
    </div>
  );
}

function Plane({
  mark,
  title,
  text,
  busy,
}: {
  mark: string;
  title: string;
  text: string;
  busy: boolean;
}) {
  return (
    <div className={cn("flex min-w-0 gap-3 px-3 py-4", busy && "opacity-70")}>
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent/15 font-mono text-micro font-bold text-accent">
        {mark}
      </span>
      <div className="min-w-0">
        <strong className="block text-meta text-text">{title}</strong>
        <small className="mt-1 block break-words text-micro leading-relaxed text-text-muted">
          {text}
        </small>
      </div>
    </div>
  );
}

export function GateView({ unsupported, s }: { unsupported: boolean; s: Dict }) {
  const v = s.details.pages.web.view;
  return (
    <section
      className="px-4 py-6 sm:px-5"
      data-testid="web-gate"
      data-web-gate={unsupported ? "unsupported" : "off"}
    >
      <div className="flex gap-4 rounded-2xl border border-accent/35 bg-accent/[0.035] px-4 py-5 sm:px-5">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-accent bg-accent/15 text-h2 text-accent">
          i
        </span>
        <div className="min-w-0">
          <Kicker>{unsupported ? v.unsupportedKicker : v.noListenerKicker}</Kicker>
          <h3 className="mt-2 text-h2 font-semibold text-text">
            {unsupported ? v.unsupportedTitle : v.noListenerTitle}
          </h3>
          <p className="mt-2 max-w-prose text-meta leading-relaxed text-text-muted">
            {unsupported ? v.unsupportedText : v.noListenerText}
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-meta text-text-muted">
            <li>{unsupported ? v.unsupportedTraffic : v.noListenerSessions}</li>
            <li>{unsupported ? v.unsupportedHow : v.noListenerHow}</li>
          </ul>
        </div>
      </div>
    </section>
  );
}

function SourceNotice({ kind, s }: { kind: "loading" | "error" | "unavailable"; s: Dict }) {
  const v = s.details.pages.web.view;
  const title = kind === "loading" ? v.loading : kind === "error" ? v.sourceError : v.unavailable;
  const text =
    kind === "loading" ? v.loadingText : kind === "error" ? v.sourceErrorText : v.unavailableText;
  return (
    <section className="px-4 py-6 sm:px-5" data-testid="web-source-notice" data-web-source={kind}>
      <div className="rounded-2xl border border-dashed border-border px-5 py-10 text-center">
        <h3 className="text-h2 font-semibold text-text">{title}</h3>
        <p className="mx-auto mt-2 max-w-prose text-meta text-text-muted">{text}</p>
      </div>
    </section>
  );
}

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
            {formatNumber(s, row.streams)} streams · {formatNumber(s, row.lanes)} lanes
          </strong>
          <span className="mt-1 block text-micro text-text-muted">
            {fill(v.pendingTemplate, { bytes: formatBytes(row.pending_bytes, s) })}
          </span>
          <small className="mt-1 block text-micro text-text-muted">
            {row.client_class} · {row.automatic ? "auto" : "manual"}
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

function SessionDetails({
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
        <SectionHeading
          kicker={v.sessionsKicker}
          title={s.details.pages.web.sessions}
          meta={v.managerBusy}
        />
        <div className="mt-5 rounded-xl border border-dashed border-border px-4 py-10 text-center">
          <IconWarning className="mx-auto text-warn" />
          <h4 className="mt-3 text-h3 font-semibold text-text">{v.sessionsBusyTitle}</h4>
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
          <Kicker>{v.sessionsKicker}</Kicker>
          <h3 className="mt-1 text-h2 font-semibold text-text">{s.details.pages.web.sessions}</h3>
          <p className="mt-1 text-meta text-text-muted">
            {loadedLabel} {v.boundedScan}
          </p>
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

function Technical({
  payload,
  unsupported,
  s,
}: {
  payload: WebPagePayload | null;
  unsupported: boolean;
  s: Dict;
}) {
  const v = s.details.pages.web.view;
  const runtime = payload?.runtime;
  const rows: Array<[string, string, string]> = unsupported
    ? [
        [v.source, WEB_STATUS_SOURCE, v.endpointAbsent],
        [v.reason, "capability_absent", v.newerVersion],
      ]
    : runtime
      ? [
          ["runtime_instance", runtime.runtime_instance, v.processFence],
          ["generation_id", formatNumber(s, runtime.generation_id), v.runtimeGeneration],
          ["lifecycle_epoch", formatNumber(s, payload?.lifecycle_epoch ?? 0), v.lifecycleEpoch],
          [
            "partial[]",
            runtime.partial.length ? runtime.partial.join(", ") : v.empty,
            v.busyPlanes,
          ],
          [
            "permits[]",
            fill(v.semaphoresTemplate, { count: formatNumber(s, runtime.permits.length) }),
            v.usedLimit,
          ],
          [
            "[web.limits]",
            fill(v.limitsCountTemplate, {
              count: formatNumber(s, Object.keys(runtime.limits).length),
            }),
            v.processOwned,
          ],
          [
            "max_sessions_global",
            String(runtime.limits["max_sessions_global"] ?? "—"),
            v.globalSessions,
          ],
          ["max_streams_global", String(runtime.limits["max_streams_global"] ?? "—"), v.allStreams],
          [
            "pending_bytes_global",
            typeof runtime.limits["pending_bytes_global"] === "number"
              ? formatBytes(runtime.limits["pending_bytes_global"], s)
              : "—",
            v.globalDataBudget,
          ],
        ]
      : [
          ["lifecycle", payload?.lifecycle ?? "no_web_listener", v.noListenerTitle],
          ["available", String(payload?.available ?? false), v.noListenerSessions],
          [
            "effective_config_enabled",
            String(payload?.effective_config_enabled ?? false),
            v.webDisabled,
          ],
        ];
  return (
    <details className="group border-t border-border px-4 py-4 sm:px-5" data-testid="web-technical">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <span>
          <strong className="block text-meta text-text">{v.technical}</strong>
          <span className="block text-micro text-text-muted">{v.technicalDescription}</span>
        </span>
        <IconChevronDown className="shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <dl className="mt-4 grid border-t border-border sm:grid-cols-2 xl:grid-cols-3">
        {rows.map(([label, value, note]) => (
          <div key={label} className="min-w-0 border-b border-r border-border px-3 py-3">
            <dt className="font-mono text-micro text-text-muted">{label}</dt>
            <dd className="mt-1 break-all font-mono text-meta font-semibold text-text">{value}</dd>
            <small className="mt-1 block text-micro text-text-muted">{note}</small>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function WebPage({ backTo = "/pulse" }: { backTo?: "/pulse" | "/server" }) {
  const s = useStrings();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const nowMs = useNow(1_000);
  const topic = useSnapshot<WebTopic>("web");
  const status = topic.data?.status?.data ?? null;
  const unsupported = topic.data?.status?.reason === "capability_absent";
  const available = status?.available === true;
  const noListener =
    status?.lifecycle === "no_web_listener" || status?.reason === "no_web_listener";
  const [tab, setTab] = useState<"overview" | "sessions">("overview");
  const sessions = useInfiniteQuery({
    ...getTelemtWebSessionsInfiniteOptions({ query: { limit: SESSIONS_PAGE_SIZE } }),
    enabled: available,
    initialPageParam: {},
    getNextPageParam: (lastPage: WebSessionPage) => lastPage.next_cursor ?? undefined,
  });
  const pages = sessions.data?.pages;
  const payload = useMemo(() => webPagePayload(status, pages), [pages, status]);
  const runtimeInstance = webRuntimeInstance(payload);
  const inputs: Record<string, DetailSourceInput> = {
    status: { kind: "topic", snapshot: topic, gated: topic.data?.status ?? null },
    sessions: {
      kind: "query",
      isPending: sessions.isPending,
      isError: sessions.isError,
      error: sessions.error ?? null,
      data: pages,
      dataUpdatedAt: sessions.dataUpdatedAt,
    },
  };
  const sources = useDetailSources(webPageDefinition.sources, inputs);
  const [intent, setIntent] = useState<CloseIntent | null>(null);
  const [selectedSession, setSelectedSession] = useState<WebSessionRow | null>(null);
  const closeSurface = useCallback(() => {
    if (intent !== null) setIntent(null);
    else setSelectedSession(null);
  }, [intent]);
  const [operationId, setOperationId] = useState<string | null>(null);
  const operation = useTelemtOperation(operationId);
  useWebCloseReport({
    operationId,
    data: operation.data,
    error: operation.error,
    onSettled: () => setOperationId(null),
    onRegistryMoved: () => {
      void queryClient.invalidateQueries({
        queryKey: getTelemtWebSessionsInfiniteQueryKey({ query: { limit: SESSIONS_PAGE_SIZE } }),
      });
    },
  });
  const closeMutation = useMutation({
    ...closeTelemtWebSessionsMutation(),
    onSuccess: (data) => {
      if (intent?.kind === "session") setSelectedSession(null);
      setIntent(null);
      setOperationId(data.operation_id);
      pushToast(s.details.pages.web.closeStarted, "ok");
    },
    onError: (error) => {
      setIntent(null);
      pushToast(apiErrorMessage(error, s), "error");
    },
  });
  function submitClose(): void {
    if (intent === null || runtimeInstance === null) return;
    closeMutation.mutate({
      body: { runtime_instance: runtimeInstance, selector: webCloseSelector(intent) },
    });
  }

  const web = s.details.pages.web;
  const v = web.view;
  const activeTab = available ? tab : "overview";
  const canClose = runtimeInstance !== null;
  const issuanceEnabled = payload?.runtime?.manager?.issuance_enabled === true;
  const runtimeLabel =
    topic.data === null
      ? topic.error
        ? v.sourceError
        : v.loading
      : unsupported
        ? v.unsupported
        : noListener
          ? v.off
          : !available || !payload?.runtime
            ? v.unavailable
            : payload.lifecycle === "draining"
              ? v.draining
              : payload.runtime.partial.length > 0
                ? v.partial
                : webHasCapacityPressure(webCapacityReadings(payload))
                  ? v.pressure
                  : v.running;
  const filterSummary = intent?.kind === "filter" ? webFilterSummary(intent.filters, s) : null;
  const confirmTitle =
    intent?.kind === "session"
      ? web.confirmSessionTitle
      : intent?.kind === "refs"
        ? web.confirmRefsTitle
        : intent?.kind === "all"
          ? web.confirmAllTitle
          : web.confirmFilterTitle;
  const confirmLabel =
    intent?.kind === "session"
      ? web.closeSession
      : intent?.kind === "all"
        ? web.closeAll
        : intent?.kind === "refs"
          ? web.closeSelected
          : web.closeByFilter;
  const confirmDescription =
    intent === null
      ? ""
      : intent.kind === "session"
        ? web.confirmSession
        : intent.kind === "refs"
          ? fill(web.confirmRefsTemplate, { count: String(intent.refs.length) })
          : intent.kind === "all"
            ? web.confirmAll
            : fill(web.confirmFilterTemplate, {
                filter: filterSummary ?? "",
                count: String(intent.visible),
              });

  return (
    <>
      <div className="w-full" data-testid="web-detail">
        <section className="overflow-hidden rounded-2xl border border-border bg-surface">
          <div className="px-4 py-5 sm:px-5">
            <DetailHeader
              title={web.title}
              description={web.description}
              breadcrumb={v.breadcrumb}
              status={sources.status}
              freshnessMs={sources.freshnessMs}
              nowMs={nowMs}
              onBack={() => void navigate({ to: backTo })}
            />
            <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-b border-border">
              <div className="flex gap-1" role="tablist" aria-label={web.title}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "overview"}
                  onClick={() => setTab("overview")}
                  className={cn(
                    "border-b-2 px-3 py-3 text-meta font-semibold",
                    activeTab === "overview"
                      ? "border-accent text-text"
                      : "border-transparent text-text-muted",
                  )}
                >
                  {v.overview}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "sessions"}
                  disabled={!available}
                  onClick={() => setTab("sessions")}
                  className={cn(
                    "border-b-2 px-3 py-3 text-meta font-semibold disabled:opacity-40",
                    activeTab === "sessions"
                      ? "border-accent text-text"
                      : "border-transparent text-text-muted",
                  )}
                >
                  {web.tabSessions}
                  <span className="ml-2 rounded-md bg-accent/15 px-1.5 py-0.5 text-micro tabular-nums text-accent">
                    {payload?.runtime?.manager
                      ? formatNumber(s, payload.runtime.manager.sessions)
                      : "—"}
                  </span>
                </button>
              </div>
              <span
                className="mb-3 text-micro font-semibold text-text-muted"
                data-web-runtime-status
              >
                {runtimeLabel}
              </span>
            </div>
          </div>
          {topic.data === null ? (
            <SourceNotice kind={topic.error ? "error" : "loading"} s={s} />
          ) : unsupported ? (
            <GateView unsupported s={s} />
          ) : noListener ? (
            <GateView unsupported={false} s={s} />
          ) : !available || !payload?.runtime ? (
            <SourceNotice kind="unavailable" s={s} />
          ) : activeTab === "sessions" ? (
            <SessionsView
              payload={payload}
              pending={sessions.isPending}
              error={sessions.isError}
              fetchingMore={sessions.isFetchingNextPage}
              hasMore={sessions.hasNextPage === true}
              closePending={closeMutation.isPending}
              canClose={canClose}
              issuanceEnabled={issuanceEnabled}
              onRetry={() => void sessions.refetch()}
              onLoadMore={() => void sessions.fetchNextPage()}
              onIntent={setIntent}
              onOpenSession={setSelectedSession}
              s={s}
            />
          ) : (
            <Overview payload={payload} s={s} />
          )}
          {topic.data !== null && <Technical payload={payload} unsupported={unsupported} s={s} />}
        </section>
      </div>
      <AdaptiveDetailSurface
        open={intent !== null || selectedSession !== null}
        onClose={closeSurface}
        title={intent !== null ? confirmTitle : (selectedSession?.user ?? "")}
        {...(intent?.kind === "session"
          ? { subtitle: intent.ref }
          : selectedSession !== null
            ? { subtitle: `${selectedSession.client_ip} · ${selectedSession.carrier}` }
            : {})}
      >
        {intent !== null ? (
          <ConfirmView
            description={confirmDescription}
            confirmLabel={confirmLabel}
            danger
            pending={closeMutation.isPending}
            onCancel={() => setIntent(null)}
            onConfirm={submitClose}
          />
        ) : selectedSession !== null ? (
          <SessionDetails
            row={selectedSession}
            s={s}
            canClose={canClose}
            closePending={closeMutation.isPending}
            onClose={() => setIntent({ kind: "session", ref: selectedSession.session_ref })}
          />
        ) : null}
      </AdaptiveDetailSurface>
    </>
  );
}
