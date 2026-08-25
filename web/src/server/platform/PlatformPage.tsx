import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ServerShell } from "../ServerShell";
import { ru, errorMessage } from "../../i18n/ru";
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
  const query = useQuery(getHostOptions());
  const [confirming, setConfirming] = useState(false);

  const restartMutation = useMutation({
    ...restartTelemtServiceMutation(),
    onSuccess: () => {
      setConfirming(false);
      pushToast(ru.server.platform.restarted, "ok");
    },
    onError: (err) => pushToast(apiErrorMessage(err), "error"),
  });

  if (query.isPending) {
    return (
      <ServerShell title={ru.server.platform.title}>
        <Skeleton className="h-40 w-full" />
      </ServerShell>
    );
  }

  if (query.isError) {
    return (
      <ServerShell title={ru.server.platform.title}>
        <ErrorState
          message={errorMessage(apiErrorCode(query.error) ?? "internal_error")}
          onRetry={() => query.refetch()}
        />
      </ServerShell>
    );
  }

  const info = query.data;
  const caps = info.caps;
  const capKeys = Object.keys(caps) as (keyof HostInfo["caps"])[];

  return (
    <ServerShell title={ru.server.platform.title}>
      <div className="rounded-xl bg-surface px-4 py-1">
        <KVRow
          label={ru.server.platform.serviceManager}
          value={info.service_manager}
        />
        <KVRow label={ru.server.platform.logSource} value={info.log_source} />
        <KVRow
          label={ru.server.platform.privilegesMode}
          value={info.privileges_mode}
        />
        {info.os_release && (
          <KVRow label={ru.server.platform.osRelease} value={info.os_release} />
        )}
      </div>

      <Card className="flex flex-col gap-2.5">
        {/* Kept as an <h2> — e2e/mobile.spec.ts asserts this heading is what
            /server/platform renders. */}
        <h2 className="text-[13px] font-semibold text-text">
          {ru.server.platform.capsTitle}
        </h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {capKeys.map((key) => (
            <div
              key={key}
              className="flex items-center gap-2 rounded-md bg-surface-2 px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-micro text-text-muted">
                {ru.server.platform.caps[key]}
              </span>
              <StatePill state={caps[key] ? "ok" : "muted"}>
                {caps[key] ? ru.common.yes : ru.common.no}
              </StatePill>
            </div>
          ))}
        </div>
      </Card>

      {info.manual_commands && Object.keys(info.manual_commands).length > 0 && (
        <Card className="flex flex-col gap-2.5">
          <CardTitle>{ru.server.platform.manualCommandsTitle}</CardTitle>
          <div className="flex flex-col gap-2.5">
            {Object.entries(info.manual_commands).map(([key, cmd]) => (
              <div key={key} className="flex flex-col gap-1">
                <p className="text-micro text-text-muted">
                  {ru.server.platform.caps[key as keyof HostInfo["caps"]] ??
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
            description={ru.server.platform.restartConfirm}
            confirmLabel={ru.server.platform.restartTelemt}
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
            {ru.server.platform.restartTelemt}
          </Button>
        )}
      </Card>
    </ServerShell>
  );
}
