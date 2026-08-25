import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ServerShell } from "../ServerShell";
import { errorMessage, useStrings } from "../../i18n";
import { KVRow } from "../../ui/KVRow";
import { StatePill } from "../../ui/StatePill";
import { Button } from "../../ui/Button";
import { Card, CardTitle } from "../../ui/Card";
import { CopyField } from "../../ui/CopyField";
import { ConfirmView } from "../../ui/ConfirmView";
import { Skeleton } from "../../ui/Skeleton";
import { ErrorState } from "../../ui/ErrorState";
import { pushToast } from "../../ui/Toast";
import { apiErrorCode, apiErrorMessage } from "../../people/apiError";
import {
  getHostOptions,
  restartTelemtServiceMutation,
} from "../../lib/api/generated/@tanstack/react-query.gen";
import type { HostInfo } from "../../lib/api/generated/types.gen";

// PlatformPage — /server/platform (06-ui.md §Сервер, 01-host-matrix.md):
// what the panel detected about the host, its capability matrix as
// StatePills, and a copyable manual command for every capability that's
// false — never a hidden or dead button, per 01-host-matrix.md's UI rule.
export function PlatformPage() {
  const s = useStrings();
  const query = useQuery(getHostOptions());
  const [confirming, setConfirming] = useState(false);

  const restartMutation = useMutation({
    ...restartTelemtServiceMutation(),
    onSuccess: () => {
      setConfirming(false);
      pushToast(s.server.platform.restarted, "ok");
    },
    onError: (err) => pushToast(apiErrorMessage(err, s), "error"),
  });

  if (query.isPending) {
    return (
      <ServerShell title={s.server.platform.title}>
        <Skeleton className="h-40 w-full" />
      </ServerShell>
    );
  }

  if (query.isError) {
    return (
      <ServerShell title={s.server.platform.title}>
        <ErrorState
          message={errorMessage(s, apiErrorCode(query.error) ?? "internal_error")}
          onRetry={() => query.refetch()}
        />
      </ServerShell>
    );
  }

  const info = query.data;
  const caps = info.caps;
  const capKeys = Object.keys(caps) as (keyof HostInfo["caps"])[];

  return (
    <ServerShell title={s.server.platform.title}>
      <div className="rounded-xl bg-surface px-4 py-1">
        <KVRow
          label={s.server.platform.serviceManager}
          value={info.service_manager}
        />
        <KVRow label={s.server.platform.logSource} value={info.log_source} />
        <KVRow
          label={s.server.platform.privilegesMode}
          value={info.privileges_mode}
        />
        {info.os_release && (
          <KVRow label={s.server.platform.osRelease} value={info.os_release} />
        )}
      </div>

      <Card className="flex flex-col gap-2.5">
        {/* Kept as an <h2> — e2e/mobile.spec.ts asserts this heading is what
            /server/platform renders. */}
        <h2 className="text-[13px] font-semibold text-text">
          {s.server.platform.capsTitle}
        </h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {capKeys.map((key) => (
            <div
              key={key}
              className="flex items-center gap-2 rounded-md bg-surface-2 px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-micro text-text-muted">
                {s.server.platform.caps[key]}
              </span>
              <StatePill state={caps[key] ? "ok" : "muted"}>
                {caps[key] ? s.common.yes : s.common.no}
              </StatePill>
            </div>
          ))}
        </div>
      </Card>

      {info.manual_commands && Object.keys(info.manual_commands).length > 0 && (
        <Card className="flex flex-col gap-2.5">
          <CardTitle>{s.server.platform.manualCommandsTitle}</CardTitle>
          <div className="flex flex-col gap-2.5">
            {Object.entries(info.manual_commands).map(([key, cmd]) => (
              <div key={key} className="flex flex-col gap-1">
                <p className="text-micro text-text-muted">
                  {s.server.platform.caps[key as keyof HostInfo["caps"]] ??
                    key}
                </p>
                <CopyField value={cmd} />
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        {confirming ? (
          <ConfirmView
            description={s.server.platform.restartConfirm}
            confirmLabel={s.server.platform.restartTelemt}
            danger
            pending={restartMutation.isPending}
            onCancel={() => setConfirming(false)}
            onConfirm={() => restartMutation.mutate({})}
          />
        ) : (
          <Button
            variant="secondary"
            disabled={!caps.restart_telemt}
            onClick={() => setConfirming(true)}
          >
            {s.server.platform.restartTelemt}
          </Button>
        )}
      </Card>
    </ServerShell>
  );
}
