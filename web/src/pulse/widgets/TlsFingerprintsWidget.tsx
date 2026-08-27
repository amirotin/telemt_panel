import type { ReactNode } from "react";
import { CountBadge } from "../../ui/Chip";
import { EmptyState } from "../../ui/EmptyState";
import { ErrorState } from "../../ui/ErrorState";
import { Skeleton } from "../../ui/Skeleton";
import { errorMessage, useStrings } from "../../i18n";
import { WidgetFrame } from "../WidgetFrame";
import { GatedNote } from "../GatedNote";
import { topFingerprints } from "./tlsFingerprints.helpers";
import { useTlsFingerprints } from "./useTlsFingerprints";

// TlsFingerprintsWidget reads GET /api/telemt/tls-fingerprints on its own
// 60s cadence instead of the `security` SSE topic: the payload is ~120 KB
// (TELEMT_LIVE_API_DATA.md §19) and used to be re-polled for every client
// every 30s just to render five rows. The runtime_edge-off case still
// renders the same GatedNote — the endpoint's 503 capability_unavailable
// maps to the gated state, not to an error (tlsFingerprints.helpers.ts).
export function TlsFingerprintsWidget({ onHide }: { onHide?: () => void }) {
  const s = useStrings();
  const fp = useTlsFingerprints();

  let body: ReactNode;
  if (fp.status === "loading") {
    body = <Skeleton className="h-16 w-full" />;
  } else if (fp.status === "gated") {
    body = <GatedNote reason={fp.reason} hint="runtime_edge" />;
  } else if (fp.status === "error") {
    body = <ErrorState message={errorMessage(s, fp.code)} onRetry={fp.refetch} />;
  } else {
    const rows = topFingerprints(fp.data);
    body =
      rows.length === 0 ? (
        <EmptyState title={s.pulse.tlsFingerprints.empty} />
      ) : (
        <ul className="flex flex-col">
          {rows.map((r) => (
            <li
              key={r.ja3}
              className="flex items-center gap-2 border-b border-border py-1.5 last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-micro text-text-muted">
                {r.ja3}
              </span>
              <CountBadge tone="muted">{r.total}</CountBadge>
            </li>
          ))}
        </ul>
      );
  }

  return (
    <WidgetFrame title={s.pulse.widgets.tls_fingerprints} diagDomain="security" onHide={onHide}>
      {body}
    </WidgetFrame>
  );
}
