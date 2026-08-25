import { useState } from "react";
import { AsyncState } from "../components/AsyncState";
import { Gated } from "../caps/Gated";
import { Card } from "../ui/Card";
import { CopyField } from "../ui/CopyField";
import { IconInfo } from "../ui/icons";
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
          return (
            <LogStreamViewer
              key={service}
              service={service}
              onServiceChange={setService}
            />
          );
        }
        if (info.caps.log_tail) {
          return (
            <LogTailFallback service={service} onServiceChange={setService} />
          );
        }
        const manual =
          info.manual_commands?.["log_stream"] ??
          info.manual_commands?.["log_tail"];
        // The bottom rung: no live stream and no tail. Presented as a
        // dimmed explanation card with the manual command inside it —
        // 01-host-matrix.md's rule is "show it disabled with the manual
        // command", and a bare error box would read as a fault rather than
        // as a platform limit. Gated itself is unchanged, just framed.
        return (
          <Card className="flex flex-col gap-3">
            {/*
              Gated carries the title ("Недоступно: …") and the "как
              включить" hint; this line adds only what it can't know — why
              the platform can't do it and what the command below is for.
            */}
            <Gated
              enabled={false}
              reason={ru.journal.gatedTitle}
              hint="log_stream"
            />
            <div className="flex items-start gap-3">
              <span className="mt-0.5 shrink-0 text-[17px] text-text-faint">
                <IconInfo />
              </span>
              <p className="text-meta leading-relaxed text-text-faint">
                {ru.journal.gatedDescription}
              </p>
            </div>
            {manual && (
              <CopyField label={ru.journal.gatedTitle} value={manual} />
            )}
          </Card>
        );
      }}
    </AsyncState>
  );
}
