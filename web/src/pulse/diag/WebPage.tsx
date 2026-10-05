import { useCallback, useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { fill, formatNumber, useStrings, type Dict } from "../../i18n";
import { closeTelemtWebSessionsMutation, getTelemtWebSessionsInfiniteOptions, getTelemtWebSessionsInfiniteQueryKey } from "../../lib/api/generated/@tanstack/react-query.gen";
import type { WebSessionPage, WebSessionRow } from "../../lib/api/generated/types.gen";
import { cn } from "../../lib/cn";
import { formatBytes } from "../../lib/format";
import { useTelemtOperation } from "../../lib/useTelemtOperation";
import { apiErrorMessage } from "../../people/apiError";
import { useNow } from "../../people/useNow";
import { useSnapshot } from "../../realtime";
import type { WebTopic } from "../../realtime/topics";
import { ConfirmView } from "../../ui/ConfirmView";
import { pushToast } from "../../ui/Toast";
import { useDetailSources, type DetailSourceInput } from "../sourceState";
import { AdaptiveDetailSurface } from "./AdaptiveDetailSurface";
import { DetailHeader } from "./DetailHeader";
import { webSources } from "./sourceDefinitions";
import { webCloseSelector, webFilterSummary, webPagePayload, webRuntimeInstance, type CloseIntent, type WebPagePayload } from "./web.helpers";
import { webCapacityReadings, webHasCapacityPressure } from "./web.view.helpers";
import { useWebCloseReport } from "./useWebCloseReport";
import { TechnicalSection } from "./TechnicalSection";
import { SourceNotice as NoticeShell } from "./SourceNotice";
import { Overview, GateView } from "./WebOverviewSection";
import { SessionsView, SessionDetails } from "./WebSessionsSection";
export { Overview, GateView } from "./WebOverviewSection";
export { SessionsView, SessionDetails } from "./WebSessionsSection";

const SESSIONS_PAGE_SIZE = 20;
const WEB_STATUS_SOURCE = "/v1/runtime/web/status";

function SourceNotice({ kind, s }: { kind: "loading" | "error" | "unavailable"; s: Dict }) {
  const v = s.details.pages.web.view;
  const title = kind === "loading" ? v.loading : kind === "error" ? v.sourceError : v.unavailable;
  const description = kind === "loading" ? v.loadingText : kind === "error" ? v.sourceErrorText : v.unavailableText;
  return <NoticeShell title={title} description={description} data-testid="web-source-notice" data-web-source={kind} />;
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
    <TechnicalSection title={v.technical} data-testid="web-technical" description={v.technicalDescription}>
      <dl className="mt-4 grid border-t border-border sm:grid-cols-2 xl:grid-cols-3">
        {rows.map(([label, value, note]) => (
          <div key={label} className="min-w-0 border-b border-r border-border px-3 py-3">
            <dt className="font-mono text-micro text-text-muted">{label}</dt>
            <dd className="mt-1 break-all font-mono text-meta font-semibold text-text">{value}</dd>
            <small className="mt-1 block text-micro text-text-muted">{note}</small>
          </div>
        ))}
      </dl>
    </TechnicalSection>
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
  const sources = useDetailSources(webSources, inputs);
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
              : payload.runtime.partial.length > 0 || (payload.capacity?.partial.length ?? 0) > 0
                ? v.partial
                : webHasCapacityPressure(webCapacityReadings(payload),payload)
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
        <DetailHeader
          title={web.title}
          description={web.description}
          backLabel={backTo === "/server" ? s.server.title : s.pulse.title}
          status={sources.status}
          freshnessMs={sources.freshnessMs}
          nowMs={nowMs}
          onBack={() => void navigate({ to: backTo })}
        />
        <section className="overflow-hidden rounded-2xl border border-border bg-surface">
          <div className="px-4 py-5 sm:px-5">
            <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border">
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
