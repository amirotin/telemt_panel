import { useSnapshot } from "../../realtime";
import type { SecurityTopic } from "../../realtime/topics";
import { KVRow } from "../../ui/KVRow";
import { StatePill } from "../../ui/StatePill";
import { Skeleton } from "../../ui/Skeleton";
import { useStrings } from "../../i18n";
import { WidgetFrame } from "../WidgetFrame";
import { computeSecurityPostureView } from "./securityPosture.helpers";

export function SecurityPostureWidget({ onHide }: { onHide?: () => void }) {
  const s = useStrings();
  const topic = useSnapshot<SecurityTopic>("security");

  if (!topic.data?.posture) {
    return (
      <WidgetFrame title={s.pulse.widgets.security_posture} onHide={onHide}>
        <Skeleton className="h-16 w-full" />
      </WidgetFrame>
    );
  }

  const view = computeSecurityPostureView(topic.data.posture, topic.data.whitelist);

  return (
    <WidgetFrame
      title={s.pulse.widgets.security_posture}
      diagDomain="security"
      onHide={onHide}
      stale={topic.stale}
    >
      <div className="flex flex-col">
        <KVRow
          label={s.pulse.securityPosture.readOnly}
          value={<StatePill state={view.readOnly ? "warn" : "ok"}>{view.readOnly ? s.common.yes : s.common.no}</StatePill>}
        />
        <KVRow
          label={s.pulse.securityPosture.whitelist}
          value={
            view.whitelistEnabled
              ? `${view.whitelistEntries} ${s.pulse.securityPosture.whitelistEntries}`
              : s.common.off
          }
        />
        <KVRow label={s.pulse.securityPosture.authHeader} value={view.authHeaderEnabled ? s.common.yes : s.common.no} />
        <KVRow
          label={s.pulse.securityPosture.proxyProtocol}
          value={view.proxyProtocolEnabled ? s.common.yes : s.common.no}
        />
        <KVRow label={s.pulse.securityPosture.logLevel} value={view.logLevel} monospace />
        <KVRow
          label={s.pulse.securityPosture.telemetry}
          value={`${view.telemetryCoreEnabled ? "core" : "—"} / ${view.telemetryUserEnabled ? "user" : "—"}`}
        />
      </div>
    </WidgetFrame>
  );
}
