import { useQuery } from "@tanstack/react-query";
import { getTelemtTlsFingerprintsOptions } from "../../lib/api/generated/@tanstack/react-query.gen";
import {
  isCapabilityCode,
  resolveTlsFingerprintsQuery,
  type TlsFingerprintsState,
} from "./tlsFingerprints.helpers";

// tlsFingerprintsLimit mirrors the panel endpoint's own default and the
// volume the live snapshot documents (TELEMT_LIVE_API_DATA.md §19: four
// lists of 50). Sent explicitly so the request is self-describing.
export const tlsFingerprintsLimit = 50;

// tlsFingerprintsRefetchMs: TLS aggregates are a slow-moving retention
// window (Telemt keeps them for retention_secs, minutes at least), and the
// response is the largest single Telemt payload — a minute is frequent
// enough for the dashboard's top-N table and cheap enough to leave running
// while the page is open. This is exactly why the data left the 30s
// `security` topic (M4 task 1).
export const tlsFingerprintsRefetchMs = 60_000;

// useTlsFingerprints fetches GET /api/telemt/tls-fingerprints and maps it
// onto the widget/page state machine. `enabled: false` (extended-mode-only
// surfaces) skips the request entirely and reports "loading" — no callers
// render that branch, they gate on the mode first.
//
// The local `retry` override matters: the app-wide default retries once
// (lib/query-client.ts), which for a switched-off capability means two
// round trips before the panel can draw a hint it already knows how to
// draw. 501/503 are settled answers about this build, not transport
// hiccups, so they are never retried; everything else keeps the default.
export function useTlsFingerprints(enabled = true): TlsFingerprintsState & { refetch: () => void } {
  const query = useTlsFingerprintsQuery(enabled);
  return { ...resolveTlsFingerprintsQuery(query), refetch: () => void query.refetch() };
}

// useTlsFingerprintsQuery is the SAME request, handed over unmapped.
//
// The Details builder resolves every source — SSE and REST alike — through
// its own §14 state machine (details-builder/sources.ts), which makes the
// R5 disabled-vs-unsupported split in one place for all eight pages. Mapping
// the query here first and re-deriving a status from the mapped result would
// be that decision made twice. Both hooks share one query key, so a page
// that uses both (none today) still issues a single request.
export function useTlsFingerprintsQuery(enabled = true) {
  return useQuery({
    ...getTelemtTlsFingerprintsOptions({ query: { limit: tlsFingerprintsLimit } }),
    refetchInterval: tlsFingerprintsRefetchMs,
    retry: (failureCount, error) => !isCapabilityCode(error?.code) && failureCount < 1,
    enabled,
  });
}
