import type { Error as ApiError, TlsFingerprintRow, TlsFingerprints } from "../../lib/api/generated/types.gen";

// topFingerprints returns the by_fingerprint rows, highest total first,
// capped at `limit` — the widget's compact "top-N" showcase (06-ui.md:
// "TLS fingerprints — top-N table"); the Диагностика page shows every
// scope (by_fingerprint/by_ip/by_cidr/by_user) in full.
export function topFingerprints(payload: TlsFingerprints, limit = 5): TlsFingerprintRow[] {
  return [...payload.by_fingerprint].sort((a, b) => b.total - a.total).slice(0, limit);
}

// TlsFingerprintsState is what useTlsFingerprints hands its callers.
//
// `disabled` and `unsupported` are deliberately NOT one state (ruling R5):
// 503 capability_unavailable means this Telemt has runtime_edge switched
// off and the admin can turn it on, while 501 capability_absent means the
// build predates the route entirely and the only way forward is an update.
// Collapsing them would have the panel telling an operator to flip a
// setting their binary does not have.
//
// `stale` on the ok branch is the same rule the SSE topics follow
// (02-hub-sse.md: "UI показывает стейл-индикатор, данные не сбрасывает") —
// a failed refetch after a good one keeps the last payload on screen with a
// badge instead of blanking the widget.
export type TlsFingerprintsState =
  | { status: "loading" }
  | { status: "disabled"; reason?: string }
  | { status: "unsupported" }
  | { status: "error"; code: string }
  | { status: "ok"; data: TlsFingerprints; stale: boolean; updatedAt: number };

// QueryLike is the narrow slice of TanStack Query's result this module
// reads — kept structural so the mapping is unit-testable without a
// QueryClient or a fake fetch.
export interface QueryLike {
  isPending: boolean;
  isError: boolean;
  error?: ApiError | null;
  data?: { enabled: boolean; reason?: string; data?: TlsFingerprints } | undefined;
  dataUpdatedAt?: number;
}

// isCapabilityCode marks the two envelope codes that mean "the server
// answered correctly, the feature just isn't there" — never a failure to
// retry, and never an error toast.
export function isCapabilityCode(code: string | undefined): boolean {
  return code === "capability_unavailable" || code === "capability_absent";
}

// resolveTlsFingerprintsQuery maps GET /api/telemt/tls-fingerprints onto
// TlsFingerprintsState.
//
// The envelope's `message` is deliberately never propagated: it is the
// panel's own English sentence (telemt_tls_handler.go), while `reason` on
// the gated states is contractually Telemt's own short token
// (`feature_disabled`), which GatedNote/caps/Gated print verbatim after a
// localized prefix. Passing the sentence through would put untranslated
// English into the Russian UI; the localized default reason plus the
// capability hint say the same thing in the reader's language.
export function resolveTlsFingerprintsQuery(query: QueryLike): TlsFingerprintsState {
  if (query.isError) {
    const code = query.error?.code ?? "internal_error";
    if (code === "capability_unavailable") return { status: "disabled" };
    if (code === "capability_absent") return { status: "unsupported" };
    // A refetch that failed after a good one: keep the payload, flag it
    // stale. Only a first-ever failure has nothing to show.
    if (query.data?.data) {
      return { status: "ok", data: query.data.data, stale: true, updatedAt: query.dataUpdatedAt ?? 0 };
    }
    return { status: "error", code };
  }
  if (query.isPending || !query.data) return { status: "loading" };
  // Defensive: the handler turns Telemt's enabled:false into the 503 above,
  // so a 200 without a payload should not happen — if it ever does, it is
  // the source being off, not an empty result set.
  if (!query.data.enabled || !query.data.data) {
    return { status: "disabled", reason: query.data.reason };
  }
  return {
    status: "ok",
    data: query.data.data,
    stale: false,
    updatedAt: query.dataUpdatedAt ?? 0,
  };
}
