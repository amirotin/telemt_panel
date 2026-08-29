import { useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { WEB_RUNTIME_HINTS } from "../../caps";
import { fill, useStrings } from "../../i18n";
import {
  closeTelemtWebSessionsMutation,
  getTelemtWebSessionsInfiniteOptions,
  getTelemtWebSessionsInfiniteQueryKey,
} from "../../lib/api/generated/@tanstack/react-query.gen";
import type { WebSessionPage } from "../../lib/api/generated/types.gen";
import { isTerminalWebOperationState, useTelemtOperation } from "../../lib/useTelemtOperation";
import type { WebTopic } from "../../realtime/topics";
import { useSnapshot } from "../../realtime";
import { ConfirmView } from "../../ui/ConfirmView";
import { Sheet } from "../../ui/Sheet";
import { pushToast } from "../../ui/Toast";
import { apiErrorMessage } from "../../people/apiError";
import { DetailPage } from "../details-builder/DetailPage";
import {
  WEB_ENDPOINT,
  WEB_PLANE_SECTIONS,
  WEB_SECTION_SESSIONS,
  webPageDefinition,
} from "../details-builder/definitions/web";
import type { SectionExtras } from "../details-builder/renderers/context";
import { useDetailSources, type DetailSourceInput } from "../details-builder/sources";
import { resolveGated } from "../widgets/gated";
import {
  WEB_CLOSE_MAX_REFS,
  WEB_PLANES,
  isWebPlaneBusy,
  webCloseIntent,
  webCloseSelector,
  webFilterSummary,
  webPagePayload,
  webRuntimeInstance,
  type CloseIntent,
} from "./web.helpers";

// WebPage — /pulse/diag/web (M4 task 8b). The first Details page that also
// ACTS: it can ask Telemt to close WEB sessions.
//
// The page owns the three things a static definition cannot:
//
//   * the SESSIONS fetch. Telemt pages them by an opaque cursor, so the
//     rows accumulate across an infinite query and «Загрузить ещё» is a real
//     second request, offered only once every loaded row is on screen.
//   * the PLANE BADGES. `partial[]` names the planes whose lock was
//     contended for the poll on screen; those sections say «занято» instead
//     of quietly showing six absent rows.
//   * the CLOSE actions, both of them behind the same ConfirmView step every
//     other irreversible action in the panel goes through, and both fenced
//     on `runtime_instance` — a close built against a Telemt that has since
//     restarted is refused by the proxy rather than applied to whatever now
//     holds those references.

/**
 * Rows per request. Telemt's own default is 50; 20 matches the builder's
 * reveal window (§10.5) so one «Загрузить ещё» is one request and one
 * screenful, rather than a button that sometimes fetches and sometimes only
 * reveals.
 */
const SESSIONS_PAGE_SIZE = 20;

export function WebPage() {
  const s = useStrings();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const topic = useSnapshot<WebTopic>("web");

  const gated = topic.data ? resolveGated(topic.data.status) : null;
  const status = gated?.status === "ok" ? gated.data : null;
  const available = status?.available === true;

  // Fetch-on-visit, and only while the runtime can answer: with WEB off
  // every one of these requests is a guaranteed 503, and a page that fires
  // them anyway would turn a clean gate notice into a retry loop.
  const sessions = useInfiniteQuery({
    ...getTelemtWebSessionsInfiniteOptions({ query: { limit: SESSIONS_PAGE_SIZE } }),
    enabled: available,
    // `{}` and not `""`: the generated queryFn turns a STRING page param
    // into `query.cursor`, so an empty first page param would put `?cursor=`
    // on the wire — which Telemt 3.5.5 answers with 400, an empty value
    // being a malformed reference rather than "no cursor". An object page
    // param merges nothing, which is exactly what the first page wants.
    initialPageParam: {},
    getNextPageParam: (lastPage: WebSessionPage) => lastPage.next_cursor ?? undefined,
  });

  const pages = sessions.data?.pages;
  const payload = useMemo(() => webPagePayload(status, pages), [status, pages]);
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

  // --- the close flow ----------------------------------------------------

  const [intent, setIntent] = useState<CloseIntent | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const operation = useTelemtOperation(operationId);

  // The terminal report, once — and then the poll stops itself.
  const operationState = operation.data?.state;
  const [reportedFor, setReportedFor] = useState<string | null>(null);
  if (
    operation.data !== undefined &&
    operationState !== undefined &&
    isTerminalWebOperationState(operationState) &&
    reportedFor !== operation.data.operation_id
  ) {
    setReportedFor(operation.data.operation_id);
    if (operationState === "completed") {
      pushToast(
        fill(s.details.pages.web.closeDoneTemplate, {
          count: String(operation.data.close_signalled),
        }),
        "ok",
      );
      if (operation.data.conflicted > 0) {
        pushToast(
          fill(s.details.pages.web.closeConflictTemplate, {
            count: String(operation.data.conflicted),
          }),
          "default",
        );
      }
    } else {
      pushToast(s.details.pages.web.closeFailed, "error");
    }
    // The registry moved: drop the accumulated pages and start the scan
    // again rather than leaving closed rows on screen.
    void queryClient.invalidateQueries({
      queryKey: getTelemtWebSessionsInfiniteQueryKey({ query: { limit: SESSIONS_PAGE_SIZE } }),
    });
  }

  const closeMutation = useMutation({
    ...closeTelemtWebSessionsMutation(),
    onSuccess: (data) => {
      setIntent(null);
      setOperationId(data.operation_id);
      pushToast(s.details.pages.web.closeStarted, "ok");
    },
    onError: (err) => {
      setIntent(null);
      pushToast(apiErrorMessage(err, s), "error");
    },
  });

  function submitClose(): void {
    if (intent === null || runtimeInstance === null) return;
    closeMutation.mutate({
      body: { runtime_instance: runtimeInstance, selector: webCloseSelector(intent) },
    });
  }

  // --- live section extensions -------------------------------------------

  const filterSummary = intent?.kind === "filter" ? webFilterSummary(intent.filters, s) : null;
  const canClose = runtimeInstance !== null;
  // `all` is the one selector Telemt refuses on a healthy runtime: it is
  // gated on issuance being off, which is a deliberate, ordered sequence
  // (web.enabled = false → issuance_enabled goes false → close all), not
  // something a button press can arrange. So the control is offered, and
  // disabled with that sequence spelled out, rather than hidden or —
  // as before — reached accidentally by pressing «Закрыть по фильтру»
  // with no filter set.
  const issuanceEnabled = payload?.runtime?.manager?.issuance_enabled === true;
  const closePending = !canClose || closeMutation.isPending;

  const sectionExtras: Record<string, SectionExtras> = {
    [WEB_SECTION_SESSIONS]: {
      continuation: {
        hasMore: sessions.hasNextPage,
        pending: sessions.isFetchingNextPage,
        onLoad: () => void sessions.fetchNextPage(),
        label: s.details.pages.web.loadMore,
      },
      actions: [
        {
          label: s.details.pages.web.closeByFilter,
          danger: true,
          disabled: closePending,
          ...(canClose ? {} : { note: s.details.pages.web.closeUnavailable }),
          maxVisible: WEB_CLOSE_MAX_REFS,
          tooManyNote: (count, max) =>
            fill(s.details.pages.web.closeTooManyTemplate, {
              count: String(count),
              max: String(max),
            }),
          onSelect: (scope) => {
            const next = webCloseIntent(scope);
            if (next !== null) setIntent(next);
          },
        },
        {
          label: s.details.pages.web.closeAll,
          danger: true,
          disabled: closePending || issuanceEnabled,
          ...(canClose
            ? issuanceEnabled
              ? { note: s.details.pages.web.closeAllBlocked }
              : {}
            : { note: s.details.pages.web.closeUnavailable }),
          onSelect: () => setIntent({ kind: "all" }),
        },
      ],
      entityAction: {
        label: s.details.pages.web.closeSession,
        danger: true,
        disabled: closePending,
        onSelect: (ref) => setIntent({ kind: "session", ref }),
      },
    },
  };
  for (const plane of WEB_PLANES) {
    if (isWebPlaneBusy(payload, plane)) {
      sectionExtras[WEB_PLANE_SECTIONS[plane]] = { badge: s.details.pages.web.planeBusy };
    }
  }

  // The confirmation names the SELECTOR KIND and the exact number of
  // sessions it carries — «эти 2» is a different promise from «все, что
  // подойдут под фильтр», and the operator has to be able to tell which one
  // they are about to send.
  const web = s.details.pages.web;
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
      <DetailPage
        definition={webPageDefinition}
        payload={payload}
        sources={sources}
        endpoint={WEB_ENDPOINT}
        onBack={() => void navigate({ to: "/pulse" })}
        onRetry={() => void sessions.refetch()}
        disabledHints={{ status: WEB_RUNTIME_HINTS, sessions: WEB_RUNTIME_HINTS }}
        sectionExtras={sectionExtras}
      />

      <Sheet
        open={intent !== null}
        onClose={() => setIntent(null)}
        title={confirmTitle}
        {...(intent?.kind === "session" ? { subtitle: intent.ref } : {})}
      >
        <ConfirmView
          description={confirmDescription}
          confirmLabel={confirmLabel}
          danger
          pending={closeMutation.isPending}
          onCancel={() => setIntent(null)}
          onConfirm={submitClose}
        />
      </Sheet>
    </>
  );
}
