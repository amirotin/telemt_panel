import type { ReactNode } from "react";
import { useSnapshot } from "../../realtime";
import type { SecurityTopic } from "../../realtime/topics";
import { CountBadge } from "../../ui/Chip";
import { EmptyState } from "../../ui/EmptyState";
import { Skeleton } from "../../ui/Skeleton";
import { useStrings } from "../../i18n";
import { WidgetFrame } from "../WidgetFrame";
import { GatedNote } from "../GatedNote";
import { resolveGated } from "./gated";
import { topFingerprints } from "./tlsFingerprints.helpers";

export function TlsFingerprintsWidget({ onHide }: { onHide?: () => void }) {
  const s = useStrings();
  const topic = useSnapshot<SecurityTopic>("security");

  if (!topic.data) {
    return (
      <WidgetFrame title={s.pulse.widgets.tls_fingerprints} onHide={onHide}>
        <Skeleton className="h-16 w-full" />
      </WidgetFrame>
    );
  }

  const fp = resolveGated(topic.data.tls_fingerprints);
  let body: ReactNode;
  if (fp.status === "gated") {
    body = <GatedNote reason={fp.reason} hint="runtime_edge" />;
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
      stale={topic.stale}
    >
      {body}
    </WidgetFrame>
  );
}
