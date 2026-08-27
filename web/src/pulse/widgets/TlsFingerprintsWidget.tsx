import type { ReactNode } from "react";
import { CountBadge } from "../../ui/Chip";
import { EmptyState } from "../../ui/EmptyState";
import { Skeleton } from "../../ui/Skeleton";
import { useStrings } from "../../i18n";
import { WidgetFrame } from "../WidgetFrame";
import { TlsSourceNotice } from "./TlsSourceNotice";
import { topFingerprints } from "./tlsFingerprints.helpers";
import { useTlsFingerprints } from "./useTlsFingerprints";

// TlsFingerprintsWidget reads GET /api/telemt/tls-fingerprints on its own
// 60s cadence instead of the `security` SSE topic: the payload is ~120 KB
// (TELEMT_LIVE_API_DATA.md §19) and used to be re-polled for every client
// every 30s just to render five rows.
//
// All four non-empty states of that source are drawn, and drawn
// differently: runtime_edge switched off is a GatedNote, an old build is
// the same note pointing at an update instead of a setting (R5), a real
// failure is an ErrorState with retry, and a failed refetch after a good
// one keeps the last rows on screen behind a stale badge — the same rule
// the SSE topics follow, which this widget must not lose by moving to REST.
export function TlsFingerprintsWidget({ onHide }: { onHide?: () => void }) {
  const s = useStrings();
  const fp = useTlsFingerprints();

  let body: ReactNode;
  if (fp.status === "loading") {
    body = <Skeleton className="h-16 w-full" />;
  } else if (fp.status !== "ok") {
    body = <TlsSourceNotice state={fp} as="note" />;
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
    <WidgetFrame
      title={s.pulse.widgets.tls_fingerprints}
      diagDomain="security"
      onHide={onHide}
      stale={fp.status === "ok" && fp.stale}
    >
      {body}
    </WidgetFrame>
  );
}
