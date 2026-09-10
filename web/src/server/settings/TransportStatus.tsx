import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useStrings } from "../../i18n";
import { getPanelTlsConfigOptions, getPanelTlsOptions } from "../../lib/api/generated/@tanstack/react-query.gen";
import { Button } from "../../ui/Button";
import { StatePill } from "../../ui/StatePill";
import { Skeleton } from "../../ui/Skeleton";
import { PanelAccessForm } from "./PanelAccessForm";

export function TransportStatus({ target = "panel" }: { target?: "panel" | "subscription" }) {
  const copy = useStrings().server.settings.transport;
  const [formOpen, setFormOpen] = useState(false);
  const subscription = target === "subscription";
  const options = subscription ? { query: { target: "subscription" as const } } : undefined;
  const query = useQuery({ ...getPanelTlsOptions(options), refetchInterval: 60_000 });
  const configQuery = useQuery({ ...getPanelTlsConfigOptions(options), refetchInterval: 60_000 });
  const data = query.data;
  const disabled = subscription && !configQuery.data?.active?.enabled;
  const behindHttps = data?.mode === "http" && (configQuery.data?.active?.public_url ? configQuery.data.active?.public_url.startsWith("https://") : !subscription && window.location.protocol === "https:");
  const plain = data?.mode === "http" && !behindHttps;
  const state = data?.state;
  const stages: Record<string, string> = copy.stages;
  return (
    <section className="rounded-xl bg-surface p-4" data-testid={subscription ? "subscription-transport" : "panel-transport"}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold text-text">{subscription ? copy.endpoints.subscriptionTitle : copy.title}</h3>
        {data && !query.isError && <StatePill state={disabled ? "muted" : plain || state === "warning" ? "warn" : state === "error" ? "error" : state === "waiting" ? "muted" : "ok"}>
          {disabled ? copy.endpoints.disabled : behindHttps ? copy.proxy : copy.modes[data.mode]}
        </StatePill>}
      </div>
      {query.isPending ? <Skeleton className="mt-3 h-8" /> : query.isError ? (
        <p className="mt-2 text-meta text-error-text">{copy.unavailable}</p>
      ) : data && (
        <div className="mt-2 space-y-2 text-meta text-text-muted">
          {data.domain && <p className="break-all font-medium text-text">{data.domain}</p>}
          {data.expires_at && <p>{copy.expires}: <time dateTime={data.expires_at}>{new Date(data.expires_at).toLocaleString()}</time></p>}
          {state === "waiting" && !disabled && <p>{copy.waiting}</p>}
          {state === "warning" && !disabled && <p className="text-warning-text">{copy.warning}</p>}
          {state === "error" && !disabled && <p className="text-error-text">{copy.failed}</p>}
          {data.error && <p className="break-words text-error-text">{data.stage ? `${stages[data.stage] ?? copy.title}: ` : ""}{data.error}</p>}
          {plain && !disabled && <p className="text-warning-text">{subscription ? copy.endpoints.httpWarning : copy.httpWarning}</p>}
          {behindHttps && <p>{copy.proxyNote}</p>}
          {configQuery.data?.restart_required && (
            <div className="rounded-lg border border-accent/25 bg-accent/8 px-3 py-2.5 text-text-muted" data-panel-transport-pending>
              <p className="font-semibold text-text">{copy.pendingRestart}</p>
              {data && <p className="mt-1">{copy.pendingActive.replace("{mode}", behindHttps ? copy.proxy : copy.modes[data.mode])}</p>}
              {configQuery.data.new_url && <p className="mt-1 break-all font-mono text-xs">{configQuery.data.new_url}</p>}
            </div>
          )}
          <p className="text-text-faint">{subscription ? copy.endpoints.subscriptionNote : copy.configNote}</p>
          {configQuery.data?.active?.public_url && <p className="break-all font-mono text-xs">{configQuery.data.active?.public_url}{configQuery.data.active.base_path}/</p>}
          <Button type="button" variant="secondary" className="mt-1 w-full sm:w-auto" onClick={() => setFormOpen(true)}>
            {copy.configure}
          </Button>
        </div>
      )}
      {formOpen && <PanelAccessForm target={target} onClose={() => setFormOpen(false)} />}
    </section>
  );
}
