import { useSnapshot } from "../../realtime";
import type { SecurityTopic } from "../../realtime/topics";
import { KVRow } from "../../ui/KVRow";
import { StatePill } from "../../ui/StatePill";
import { Skeleton } from "../../ui/Skeleton";
import { ru } from "../../i18n/ru";
import { WidgetFrame } from "../WidgetFrame";
import { computeSecurityPostureView } from "./securityPosture.helpers";

export function SecurityPostureWidget({ onHide }: { onHide?: () => void }) {
  const topic = useSnapshot<SecurityTopic>("security");

  if (!topic.data?.posture) {
    return (
      <WidgetFrame title={ru.pulse.widgets.security_posture} onHide={onHide}>
        <Skeleton className="h-16 w-full" />
      </WidgetFrame>
    );
  }

  const view = computeSecurityPostureView(topic.data.posture, topic.data.whitelist);

  return (
    <WidgetFrame
      title={ru.pulse.widgets.security_posture}
      diagDomain="security"
      onHide={onHide}
      stale={topic.stale}
    >
      <div className="flex flex-col">
        <KVRow
          label={ru.pulse.securityPosture.readOnly}
          value={<StatePill state={view.readOnly ? "warn" : "ok"}>{view.readOnly ? "да" : "нет"}</StatePill>}
        />
        <KVRow
          label={ru.pulse.securityPosture.whitelist}
          value={
            view.whitelistEnabled
              ? `${view.whitelistEntries} ${ru.pulse.securityPosture.whitelistEntries}`
              : "выкл."
          }
        />
        <KVRow label={ru.pulse.securityPosture.authHeader} value={view.authHeaderEnabled ? "да" : "нет"} />
        <KVRow
          label={ru.pulse.securityPosture.proxyProtocol}
          value={view.proxyProtocolEnabled ? "да" : "нет"}
        />
        <KVRow label={ru.pulse.securityPosture.logLevel} value={view.logLevel} monospace />
        <KVRow
          label={ru.pulse.securityPosture.telemetry}
          value={`${view.telemetryCoreEnabled ? "core" : "—"} / ${view.telemetryUserEnabled ? "user" : "—"}`}
        />
      </div>
    </WidgetFrame>
  );
}
