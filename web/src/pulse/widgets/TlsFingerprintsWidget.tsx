import type { ReactNode } from "react";
import { useSnapshot } from "../../realtime";
import type { SecurityTopic } from "../../realtime/topics";
import { Gated } from "../../caps";
import { EmptyState } from "../../ui/EmptyState";
import { Skeleton } from "../../ui/Skeleton";
import { ru } from "../../i18n/ru";
import { WidgetFrame } from "../WidgetFrame";
import { resolveGated } from "./gated";
import { topFingerprints } from "./tlsFingerprints.helpers";

export function TlsFingerprintsWidget({ onHide }: { onHide?: () => void }) {
  const topic = useSnapshot<SecurityTopic>("security");

  if (!topic.data) {
    return (
      <WidgetFrame title={ru.pulse.widgets.tls_fingerprints} onHide={onHide}>
        <Skeleton className="h-16 w-full" />
      </WidgetFrame>
    );
  }

  const fp = resolveGated(topic.data.tls_fingerprints);
  let body: ReactNode;
  if (fp.status === "gated") {
    body = <Gated enabled={false} reason={fp.reason} hint="runtime_edge" />;
  } else {
    const rows = topFingerprints(fp.data);
    body =
      rows.length === 0 ? (
        <EmptyState title={ru.pulse.tlsFingerprints.empty} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-text-muted">
                <th className="py-1.5 pr-3 font-medium">JA3</th>
                <th className="py-1.5 font-medium">{ru.pulse.tlsFingerprints.total}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ja3} className="border-b border-border last:border-b-0">
                  <td className="py-1.5 pr-3 truncate font-mono text-xs text-text">{r.ja3}</td>
                  <td className="py-1.5 tabular-nums text-text-muted">{r.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }

  return (
    <WidgetFrame
      title={ru.pulse.widgets.tls_fingerprints}
      diagDomain="security"
      onHide={onHide}
      stale={topic.stale}
    >
      {body}
    </WidgetFrame>
  );
}
