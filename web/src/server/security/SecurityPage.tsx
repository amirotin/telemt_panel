import { ServerShell } from "../ServerShell";
import { ru } from "../../i18n/ru";
import { KVRow } from "../../ui/KVRow";
import { StatePill } from "../../ui/StatePill";
import { Card, CardTitle } from "../../ui/Card";
import { Skeleton } from "../../ui/Skeleton";
import { Gated } from "../../caps/Gated";
import { useSnapshot } from "../../realtime";
import type { SecurityTopic } from "../../realtime/topics";
import { useDisplayMode, visibleFor } from "../../display-mode";
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
  const extended = visibleFor("extended", mode);

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
      <div className="flex flex-wrap items-center gap-2">
        {topic.stale && <StatePill state="warn">{ru.common.stale}</StatePill>}
        <p className="text-micro text-text-faint">
          {ru.server.security.editHint}
        </p>
      </div>

      {topic.data.posture && (
        <Card className="flex flex-col gap-1">
          <CardTitle className="pb-1">
            {ru.server.security.postureTitle}
          </CardTitle>
          {postureBadges(topic.data.posture).map((b) => (
            <KVRow
              key={b.key}
              label={b.label}
              value={<StatePill state={b.state}>{b.text}</StatePill>}
            />
          ))}
          <KVRow
            label={ru.server.security.logLevel}
            value={topic.data.posture.log_level}
            monospace
          />
          <KVRow
            label={ru.server.security.telemetryMeLevel}
            value={topic.data.posture.telemetry_me_level}
            monospace
          />
        </Card>
      )}

      {topic.data.whitelist && (
        <Card className="flex flex-col gap-2.5">
          <CardTitle
            action={
              topic.data.whitelist.entries.length > 0 ? (
                <span className="text-micro tabular-nums text-text-faint">
                  {ru.server.security.whitelistEntriesTotal}:{" "}
                  {topic.data.whitelist.entries_total}
                </span>
              ) : undefined
            }
          >
            {ru.server.security.whitelistTitle}
          </CardTitle>
          {topic.data.whitelist.entries.length === 0 ? (
            <p className="text-meta text-text-muted">
              {ru.server.security.whitelistEmpty}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {topic.data.whitelist.entries.map((entry) => (
                <span
                  key={entry}
                  className="inline-flex items-center rounded-full bg-surface-2 px-3 py-2 font-mono text-xs tabular-nums text-text"
                >
                  {entry}
                </span>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* KVGroupList captions each group itself (D2 made it a card with a
          SectionLabel header), and securityGroups' first group is already
          «Действующие лимиты» — a wrapper caption here printed it twice. */}
      <KVGroupList
        groups={securityGroups({
          effectiveLimits: topic.data.effective_limits ?? undefined,
          tlsFingerprints: extended && tls.status === "ok" ? tls.data : undefined,
        })}
      />

      {!extended && (
        <p className="text-micro text-text-faint">
          {ru.server.security.tlsExtendedOnly}
        </p>
      )}
      {extended && tls.status === "gated" && (
        <Gated enabled={false} reason={tls.reason} hint="runtime_edge" />
      )}
    </ServerShell>
  );
}
