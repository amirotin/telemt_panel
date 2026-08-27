import { useQuery } from "@tanstack/react-query";
import { getTelemtTlsFingerprintsOptions } from "../../lib/api/generated/@tanstack/react-query.gen";
import { resolveTlsFingerprintsQuery, type TlsFingerprintsState } from "./tlsFingerprints.helpers";

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
export function useTlsFingerprints(enabled = true): TlsFingerprintsState & { refetch: () => void } {
  const query = useQuery({
    ...getTelemtTlsFingerprintsOptions({ query: { limit: tlsFingerprintsLimit } }),
    refetchInterval: tlsFingerprintsRefetchMs,
    enabled,
  });
  return { ...resolveTlsFingerprintsQuery(query), refetch: () => void query.refetch() };
}
