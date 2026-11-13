import { useState } from "react";
import { withBasePath } from "../../lib/base-path";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getTelemtServiceOptions,
  getTelemtServiceQueryKey,
  getHostQueryKey,
  getUpdatesQueryKey,
} from "../../lib/api/generated/@tanstack/react-query.gen";
import {
  startTelemtService,
  stopTelemtService,
  restartTelemtService,
} from "../../lib/api/generated/sdk.gen";
import { errorMessage, useStrings } from "../../i18n";
import { apiErrorCode } from "../../people/apiError";
import { Button } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";
import { StatePill } from "../../ui/StatePill";
import { CopyField } from "../../ui/CopyField";
import { IconPlay, IconPower, IconRefresh, IconTerminal } from "../../ui/icons";
import { pushToast } from "../../ui/Toast";
import { Skeleton } from "../../ui/Skeleton";

type Action = "start" | "stop" | "restart";
const commands = {
  start: startTelemtService,
  stop: stopTelemtService,
  restart: restartTelemtService,
};
const icons = { start: IconPlay, stop: IconPower, restart: IconRefresh };

export function TelemtServiceControl() {
  const s = useStrings(),
    t = s.serviceControl,
    cache = useQueryClient();
  const [action, setAction] = useState<Action | null>(null);
  const query = useQuery({ ...getTelemtServiceOptions(), refetchInterval: 5000, retry: false });
  const mutation = useMutation({
    mutationFn: async (next: Action) => {
      await commands[next]({ throwOnError: true });
    },
    retry: false,
    onSuccess: () => {
      setAction(null);
      pushToast(t.accepted, "ok");
    },
    onSettled: () => {
      void cache.invalidateQueries({ queryKey: getTelemtServiceQueryKey() });
      void cache.invalidateQueries({ queryKey: getHostQueryKey() });
      void cache.invalidateQueries({ queryKey: getUpdatesQueryKey() });
    },
  });
  const data = query.data,
    stale = query.isError,
    status = stale ? "unknown" : (data?.status ?? "unknown");
  const labels = { start: t.start, stop: t.stop, restart: t.restart },
    confirm = { start: t.confirmStart, stop: t.confirmStop, restart: t.confirmRestart },
    notes = { start: t.startNote, stop: t.stopNote, restart: t.restartNote };
  const nativeState = stale ? undefined : data?.native_state;
  const stateLabel = nativeState === "failed" ? t.failed
    : nativeState === "activating" ? t.activating
    : nativeState === "deactivating" ? t.deactivating
    : nativeState === "reloading" ? t.reloading
    : status === "running" ? t.running : status === "stopped" ? t.stopped : t.unknown;
  const blocked = mutation.isPending || query.isPending || stale || !!data?.busy;
  const allowed = action && !!data?.caps[action];
  const managerLabel = data?.manager === "custom" ? t.customManager : (data?.manager ?? "—");
  return (
    <section className="border-t border-border px-4 py-4" data-testid="telemt-service-control">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-[16px] font-semibold">{t.title}</h3>
          <p className="mt-1 text-meta text-text-muted">
            {t.host} · {managerLabel} · <code>{data?.service || t.notConfigured}</code>
          </p>
        </div>
        <StatePill state={nativeState === "failed" ? "error" : status === "running" ? "ok" : "muted"}>
          {stateLabel}
        </StatePill>
      </header>
      {query.isPending ? (
        <Skeleton className="mt-4 h-20 w-full" />
      ) : (
        <>
          <p className="mt-3 text-meta leading-relaxed text-text-muted">{t.separate}</p>
          {nativeState === "failed" && (
            <a href={withBasePath("/journal")} className="mt-3 inline-flex min-h-11 items-center text-meta text-accent">
              {t.logs}
            </a>
          )}
          {status === "unknown" && !["activating", "deactivating", "reloading"].includes(nativeState ?? "") && (
            <p className="mt-3 rounded-lg border border-border bg-surface-2 p-3 text-meta leading-relaxed text-text-muted">
              {t.unknownNote}
            </p>
          )}
          {data?.binding_conflict && <p className="mt-3 text-meta text-warn">{t.conflict}</p>}
          {data?.busy && (
            <p className="mt-3 text-meta text-warn" role="status">
              {t.busy}
            </p>
          )}
          {stale && (
            <p className="mt-3 text-meta text-warn" role="alert">
              {errorMessage(s, apiErrorCode(query.error) ?? "network")}
            </p>
          )}
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {(["start", "stop", "restart"] as const).map((next) => {
              const permitted = !!data?.caps[next],
                Icon = permitted ? icons[next] : IconTerminal;
              const already =
                permitted &&
                ((next === "start" && status === "running") ||
                  (next === "stop" && status === "stopped"));
              return (
                <Button
                  key={next}
                  variant={next === "start" && permitted ? "primary" : "secondary"}
                  className={`${next === "restart" ? "col-span-2 sm:col-span-1" : ""} ${next === "stop" && permitted ? "!border-warn/30 !bg-warn/10 !text-warn" : ""}`}
                  disabled={
                    !data || blocked || already || (data.binding_conflict && next !== "restart")
                  }
                  data-testid={next === "restart" ? "platform-restart-action" : undefined}
                  onClick={() => {
                    mutation.reset();
                    setAction(next);
                  }}
                >
                  <Icon className="h-4 w-4" />
                  {labels[next]}
                </Button>
              );
            })}
          </div>
          <button
            type="button"
            className="mt-2 min-h-11 text-meta text-accent disabled:opacity-40"
            disabled={query.isFetching || mutation.isPending}
            onClick={() => void query.refetch()}
          >
            {t.refresh}
          </button>
        </>
      )}
      <Sheet
        open={action !== null}
        onClose={() => {
          if (!mutation.isPending) setAction(null);
        }}
        title={
          action
            ? allowed
              ? confirm[action]
              : `${t.manual}: ${labels[action].toLowerCase()}`
            : t.title
        }
        eyebrow={t.host}
        subtitle={`${managerLabel} · ${data?.service || t.notConfigured}`}
      >
        {action && (
          <div className="flex flex-col gap-4">
            <p className="text-meta leading-relaxed text-text-muted">{t.separate}</p>
            {allowed ? (
              <>
                {status === "unknown" && (
                  <p className="rounded-xl border border-warn/30 bg-warn/10 p-3 text-meta leading-relaxed text-warn">
                    {t.unknownNote}
                  </p>
                )}
                <p className="text-meta leading-relaxed">{notes[action]}</p>
                {mutation.isError && (
                  <div role="alert" className="text-meta leading-relaxed text-warn">
                    <p>{errorMessage(s, apiErrorCode(mutation.error) ?? "network")}</p>
                    <p className="mt-2">{t.recheck}</p>
                  </div>
                )}
                {data?.busy && !mutation.isPending && (
                  <p className="text-meta text-warn">{t.busy}</p>
                )}
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    variant="secondary"
                    disabled={mutation.isPending}
                    onClick={() => setAction(null)}
                  >
                    {s.common.cancel}
                  </Button>
                  <Button
                    variant={action === "start" ? "primary" : "danger"}
                    disabled={blocked}
                    onClick={() => {
                      if (!blocked && data?.caps[action]) mutation.mutate(action);
                    }}
                  >
                    {mutation.isPending ? s.common.loading : confirm[action]}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-meta leading-relaxed text-text-muted">
                  {data?.binding_conflict && action !== "restart" ? t.conflict : t.manualNote}
                </p>
                {data?.manual_commands?.[action] ? (
                  <CopyField
                    value={data.manual_commands[action]}
                    data-testid={action === "restart" ? "platform-manual-restart" : undefined}
                  />
                ) : (
                  <p className="text-meta text-text-muted">{t.noCommand}</p>
                )}
              </>
            )}
          </div>
        )}
      </Sheet>
    </section>
  );
}
