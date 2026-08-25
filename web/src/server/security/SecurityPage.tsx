import { ServerShell } from "../ServerShell";
import { ru } from "../../i18n/ru";
import { KVRow } from "../../ui/KVRow";
import { StatePill } from "../../ui/StatePill";
import { Skeleton } from "../../ui/Skeleton";
import { Gated } from "../../caps/Gated";
import { useSnapshot } from "../../realtime";
import type { SecurityTopic } from "../../realtime/topics";
import { useDisplayMode } from "../../display-mode";
import { resolveGated } from "../../pulse/widgets/gated";
import { securityGroups } from "../../pulse/diag/security.helpers";
import { KVGroupList } from "../../pulse/diag/KVGroupList";
import { postureBadges } from "./posture.helpers";

// SecurityPage — /server/security (06-ui.md §Сервер): read-only render of
// the `security` SSE topic (posture as KVRow+StatePill, whitelist as
// cards, effective limits + TLS fingerprints reusing the Диагностика
// page's existing securityGroups/KVGroupList — same data, task 6's own
// completeness backbone, no reason to re-flatten it differently here).
// Everything on this page is read-only with a "правится в конфиге Telemt"
// note — there is no edit path for security posture through the panel.
export function SecurityPage() {
  const topic = useSnapshot<SecurityTopic>("security");
  const { mode } = useDisplayMode();
  const extended = mode === "extended";

  if (!topic.data) {
    return (
      <ServerShell title={ru.server.security.title}>
        <Skeleton className="h-40 w-full" />
      </ServerShell>
    );
  }

  const tls = resolveGated(topic.data.tls_fingerprints);

  return (
    <ServerShell title={ru.server.security.title}>
      {topic.stale && <StatePill state="warn">{ru.common.stale}</StatePill>}
      <p className="text-xs text-text-faint">{ru.server.security.editHint}</p>

      {topic.data.posture && (
        <section className="rounded-xl border border-border bg-surface p-4">
          <h2 className="mb-2 text-sm font-semibold text-text">{ru.server.security.postureTitle}</h2>
          <div className="flex flex-col">
            {postureBadges(topic.data.posture).map((b) => (
              <KVRow key={b.key} label={b.label} value={<StatePill state={b.state}>{b.text}</StatePill>} />
            ))}
            <KVRow label={ru.server.security.logLevel} value={topic.data.posture.log_level} monospace />
            <KVRow label={ru.server.security.telemetryMeLevel} value={topic.data.posture.telemetry_me_level} monospace />
          </div>
        </section>
      )}

      {topic.data.whitelist && (
        <section className="rounded-xl border border-border bg-surface p-4">
          <h2 className="mb-2 text-sm font-semibold text-text">{ru.server.security.whitelistTitle}</h2>
          {topic.data.whitelist.entries.length === 0 ? (
            <p className="text-sm text-text-muted">{ru.server.security.whitelistEmpty}</p>
          ) : (
            <>
              <p className="mb-2 text-xs text-text-faint">
                {ru.server.security.whitelistEntriesTotal}: {topic.data.whitelist.entries_total}
              </p>
              <div className="flex flex-wrap gap-2">
                {topic.data.whitelist.entries.map((entry) => (
                  <span
                    key={entry}
                    className="rounded-lg border border-border bg-surface-2 px-3 py-1.5 font-mono text-xs text-text"
                  >
                    {entry}
                  </span>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      <div>
        <h2 className="mb-2 text-sm font-semibold text-text">{ru.server.security.limitsTitle}</h2>
        <KVGroupList
          groups={securityGroups({
            effectiveLimits: topic.data.effective_limits ?? undefined,
            tlsFingerprints: extended && tls.status === "ok" ? tls.data : undefined,
          })}
        />
      </div>

      {!extended && <p className="text-xs text-text-faint">{ru.server.security.tlsExtendedOnly}</p>}
      {extended && tls.status === "gated" && <Gated enabled={false} reason={tls.reason} hint="runtime_edge" />}
    </ServerShell>
  );
}
