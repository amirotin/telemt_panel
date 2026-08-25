import type { RuntimeEdgeTLSFingerprintRow, RuntimeEdgeTLSFingerprints } from "../../realtime/topics";

// topFingerprints returns the by_fingerprint rows, highest total first,
// capped at `limit` — the widget's compact "top-N" showcase (06-ui.md:
// "TLS fingerprints — top-N table"); the Диагностика page shows every
// scope (by_fingerprint/by_ip/by_cidr/by_user) in full.
export function topFingerprints(payload: RuntimeEdgeTLSFingerprints, limit = 5): RuntimeEdgeTLSFingerprintRow[] {
  return [...payload.by_fingerprint].sort((a, b) => b.total - a.total).slice(0, limit);
}
