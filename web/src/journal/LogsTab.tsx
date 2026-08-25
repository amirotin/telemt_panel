import { useState } from "react";
import { AsyncState } from "../components/AsyncState";
import { Gated } from "../caps/Gated";
import { CopyField } from "../ui/CopyField";
import { ru } from "../i18n/ru";
import { apiErrorCode } from "../people/apiError";
import { useHostInfo } from "./useHostInfo";
import { LogStreamViewer } from "./LogStreamViewer";
import { LogTailFallback } from "./LogTailFallback";
import type { LogicalService } from "./types";

// LogsTab — Task 7 deliverable A/B: GET /api/host picks between the three
// rungs of the degradation ladder (01-host-matrix.md UI rule: an
// unavailable operation is shown disabled with its manual command, never
// hidden) — live stream, tail-only fallback, or a fully-gated block with
// copyable manual commands. `service` (telemt/panel) lives here so it
// survives switching between those three branches (e.g. a host reporting
// caps that flip mid-session after a config reload).
export function LogsTab() {
  const host = useHostInfo();
  const [service, setService] = useState<LogicalService>("telemt");

  return (
    <AsyncState
      isPending={host.isPending}
      isError={host.isError}
      errorCode={apiErrorCode(host.error)}
      data={host.data}
      onRetry={() => void host.refetch()}
    >
      {(info) => {
        if (info.caps.log_stream) {
          return <LogStreamViewer key={service} service={service} onServiceChange={setService} />;
        }
        if (info.caps.log_tail) {
          return <LogTailFallback service={service} onServiceChange={setService} />;
        }
        const manual = info.manual_commands?.["log_stream"] ?? info.manual_commands?.["log_tail"];
        return (
          <div className="flex flex-col gap-3">
            <Gated enabled={false} reason={ru.journal.gatedTitle} />
            {manual && <CopyField label={ru.journal.gatedTitle} value={manual} />}
          </div>
        );
      }}
    </AsyncState>
  );
}
