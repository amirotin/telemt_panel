import type { Error as ApiError, TlsFingerprintRow, TlsFingerprints } from "../../lib/api/generated/types.gen";

// topFingerprints returns the by_fingerprint rows, highest total first,
// capped at `limit` — the widget's compact "top-N" showcase (06-ui.md:
// "TLS fingerprints — top-N table"); the Диагностика page shows every
// scope (by_fingerprint/by_ip/by_cidr/by_user) in full.
export function topFingerprints(payload: TlsFingerprints, limit = 5): TlsFingerprintRow[] {
  return [...payload.by_fingerprint].sort((a, b) => b.total - a.total).slice(0, limit);
}

// TlsFingerprintsState is what useTlsFingerprints hands its callers: the
// same four-way split every runtime-edge surface already renders, but
// derived from a REST query instead of a Gated[T] topic field.
export type TlsFingerprintsState =
  | { status: "loading" }
  | { status: "gated"; reason?: string }
  | { status: "error"; code: string }
  | { status: "ok"; data: TlsFingerprints };

// QueryLike is the narrow slice of TanStack Query's result this module
// reads — kept structural so the mapping is unit-testable without a
// QueryClient or a fake fetch.
export interface QueryLike {
  isPending: boolean;
  isError: boolean;
  error?: ApiError | null;
  data?: { enabled: boolean; reason?: string; data?: TlsFingerprints } | undefined;
}

// resolveTlsFingerprintsQuery maps GET /api/telemt/tls-fingerprints onto
// TlsFingerprintsState. The load-bearing rule: the endpoint's 503
// capability_unavailable — the panel's answer when Telemt reports
// runtime_edge off (telemt_tls_handler.go) — is NOT an error, it is the
// gated state, so the UI keeps showing its Gated hint rather than an error
// toast and a retry button. Every other failure stays a real error, which
// is what keeps an unreachable Telemt (502 telemt_unreachable) visible.
// A 200 whose payload is somehow not enabled is treated as gated too,
// defensively, rather than rendered as empty data.
export function resolveTlsFingerprintsQuery(query: QueryLike): TlsFingerprintsState {
  if (query.isError) {
    const code = query.error?.code ?? "internal_error";
    if (code === "capability_unavailable" || code === "capability_absent") {
      return { status: "gated", reason: query.error?.message };
    }
    return { status: "error", code };
  }
  if (query.isPending || !query.data) return { status: "loading" };
  if (!query.data.enabled || !query.data.data) {
    return { status: "gated", reason: query.data.reason };
  }
  return { status: "ok", data: query.data.data };
}
