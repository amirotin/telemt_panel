import { fill, formatNumber, type Dict } from "../../i18n";
import { cn } from "../../lib/cn";
import { formatBytes } from "../../lib/format";
import { HelpHint } from "../../ui/HelpHint";
import { type WebPagePayload } from "./web.helpers";
import { webCapacityReadings, webHasCapacityPressure, type WebCapacityReading } from "./web.view.helpers";
import { WebRejections } from "./WebRejections";
import { formatCoarseDuration as formatDurationApprox } from "../formatting";
import { SectionHeading } from "./SectionHeading";
const PRIMARY_CAPACITY = new Set(["sessions","streams","http","queue","websocket"]);

function Vital({
  label,
  value,
  note,
  tone = "neutral",
  hint,
}: {
  label: string;
  value: string;
  note: string;
  tone?: "good" | "warn" | "bad" | "neutral";
  hint?: { label: string; text: string };
}) {
  return (
    <div className="min-w-0 px-3 py-4 sm:px-4" data-web-vital={label}>
      <span className="flex min-h-11 items-center text-meta text-text-muted">{label}{hint && <HelpHint label={hint.label}>{hint.text}</HelpHint>}</span>
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
    ...v.capacityResources,
  };
  const format = (value: number) =>
    reading.bytes ? formatBytes(value, s) : formatNumber(s, value);
  const value =
    reading.value === null || reading.limit === null
      ? v.managerBusy
      : `${format(reading.value)} / ${format(reading.limit)} · ${reading.closed ? v.resourceClosed : `${formatNumber(s, reading.percent ?? 0)}%`}`;
  return (
    <div className="py-2.5" data-web-capacity={reading.id} data-web-tone={reading.tone}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-meta">
        <strong className="text-text">{labels[reading.id] ?? reading.resource ?? reading.id}</strong>
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
  const partial = [...new Set([...(runtime?.partial ?? []),...(payload.capacity?.partial ?? [])])];
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
  if (partial.length > 0) {
    return (
      <div className="border-b border-border bg-surface-2 px-4 py-3 sm:px-5">
        <strong className="block text-meta text-text">{v.partialTitle}</strong>
        <span className="mt-1 block text-meta text-text-muted">
          {fill(v.partialTextTemplate, { planes: partial.join(", ") })}
        </span>
      </div>
    );
  }
  if (payload.capacity && webHasCapacityPressure(webCapacityReadings(payload),payload)) {
    return (
      <div className="border-b border-warn/40 bg-warn-soft/10 px-4 py-3 sm:px-5" data-testid="web-current-pressure">
        <strong className="block text-meta text-warn">{v.pressureTitle}</strong>
        <span className="mt-1 block text-meta text-text-muted">
          {payload.capacity.saturated_resources.map(resource=>v.capacityResources[resource as keyof typeof v.capacityResources]??resource).join(" · ")}
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
  const primaryReadings = readings.filter(reading=>PRIMARY_CAPACITY.has(reading.id));
  const extraReadings = readings.filter(reading=>!PRIMARY_CAPACITY.has(reading.id));
  const extraPressure = extraReadings.some(reading=>reading.tone==="warn"||reading.tone==="bad");
  const sessionLimit = readings.find((reading) => reading.id === "sessions")?.limit;
  const streamLimit = readings.find((reading) => reading.id === "streams")?.limit;
  const issuance = payload.operator_lifecycle?.effective_new_work_admission ?? manager?.issuance_enabled;
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
          hint={{label:v.limitExplanationTitle,text:v.limitExplanation}}
          value={formatNumber(s, runtime.limit_hits)}
          note={runtime.limit_hits > 0 ? v.sinceStart : v.noLimitHits}
          tone={runtime.limit_hits > 0 ? "neutral" : "good"}
        />
      </section>

      <div className="grid border-b border-border xl:grid-cols-[minmax(0,1.7fr)_minmax(280px,0.8fr)]">
        <section
          className="px-4 py-5 sm:px-5 xl:border-r xl:border-border"
          data-testid="web-capacity"
        >
          <SectionHeading level={2} variant="standard" kicker={v.capacityKicker} title={v.capacityTitle} meta={v.usedLimit} />
          <div className="mt-3">
            {primaryReadings.map((reading) => (
              <CapacityRow key={reading.id} reading={reading} s={s} />
            ))}
          </div>
          {extraReadings.length>0&&<details className="border-t border-border" open={extraPressure}>
            <summary className={cn("min-h-11 cursor-pointer py-3 text-meta font-semibold",extraPressure?"text-warn":"text-text-muted")}>{v.extraCapacity} · {formatNumber(s,extraReadings.length)}</summary>
            <div className="grid gap-x-5 xl:grid-cols-2">{extraReadings.map(reading=><CapacityRow key={reading.id} reading={reading} s={s}/>)}</div>
          </details>}
          <p className="mt-2 border-t border-border pt-3 text-micro leading-relaxed text-text-muted">
            {v.capacityNote}
          </p>
          <WebRejections payload={payload} s={s}/>
        </section>

        <section className="px-4 py-5 sm:px-5" data-testid="web-runtime">
          <SectionHeading level={2} variant="standard" kicker={v.runtimeKicker} title={v.runtimeTitle} />
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
          {payload.ingress && <div className="mt-3 border-t border-border pt-2" data-testid="web-ingress">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center text-meta text-text-muted">{v.privateIngress}<HelpHint label={v.privateIngress}>{v.privateIngressNote}</HelpHint></span>
              <span className="shrink-0 font-mono text-meta">{formatNumber(s,payload.ingress.live_acceptors)} / {formatNumber(s,payload.ingress.configured_listeners)}</span>
            </div>
            <p className={cn("text-meta",payload.ingress.accepting_connections?"text-ok":"text-warn")}>{payload.ingress.accepting_connections?v.accepting:v.notAccepting}{payload.ingress.reason&&<> · {v.ingressReasons[payload.ingress.reason as keyof typeof v.ingressReasons]??payload.ingress.reason}</>}</p>
          </div>}
        </section>
      </div>

      <section className="border-b border-border px-4 py-5 sm:px-5" data-testid="web-flow">
        <SectionHeading level={2} variant="standard" kicker={v.flowKicker} title={v.flowTitle} meta={v.notRealtime} />
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
        <SectionHeading level={2} variant="standard" kicker={v.planesKicker} title={v.planesTitle} meta={v.planesIndependent} />
        <div className="mt-4 grid divide-y divide-border border-y border-border lg:grid-cols-3 lg:divide-x lg:divide-y-0">
          <Plane
            mark="WS"
            title={v.websocketRegistry}
            busy={partial.includes("websockets")}
            text={
              websocket
                ? fill(v.websocketSummaryTemplate, {
                  entries: formatNumber(s, websocket.entries),
                  claims: formatNumber(s, websocket.claims),
                  evictions: formatNumber(s, websocket.evictions_in_flight),
                })
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
          <SectionHeading level={2} variant="standard" kicker={unsupported ? v.unsupportedKicker : v.noListenerKicker} title={unsupported ? v.unsupportedTitle : v.noListenerTitle} />
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
