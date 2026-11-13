import type { TelemtConfigState } from "../../lib/api/generated/types.gen";
import { errorMessage, useStrings } from "../../i18n";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { nativeStateMatches, nativeStatePaths } from "./configNativeState";

export function ConfigNativeState({ state, error, pending, readOnly, canReload, onRefresh, onReload }: {
  state?: TelemtConfigState; error?: { code?: string; message?: string } | null;
  pending: boolean; readOnly: boolean; canReload: boolean; onRefresh: () => void; onReload: () => void;
}) {
  const s = useStrings();
  const copy = s.server.config.native;
  if (error?.code === "capability_absent") return null;
  if ((!state || !state.comparison || !state.runtime) && (!error || error.code === "capability_absent")) return null;
  const matches = !error && nativeStateMatches(state);
  const watcher = state?.watcher as { error_code?: string | null } | null | undefined;
  const reload = state?.reload as { error_present?: boolean } | null | undefined;
  const groups = [
    { label: copy.automatic, paths: nativeStatePaths(state, "watcher_pending_paths") },
    { label: copy.reload, paths: nativeStatePaths(state, "generation_pending_paths") },
    { label: copy.restart, paths: nativeStatePaths(state, "process_deferred_paths") },
  ];
  const failure = state?.desired_error ?? state?.projection_error;
  return <section data-testid="config-native-state"><Card className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-bold text-text">{copy.title}</h2><Button variant="ghost" size="sm" onClick={onRefresh}>{copy.refresh}</Button></div>
    <p className="text-meta text-text-muted">{matches ? copy.matches : copy.unknown}</p>
    {error && <p role="alert" className="text-meta text-bad">{errorMessage(s, error.code ?? "telemt_api_error", error.message)}</p>}
    {state?.desired_status !== "valid" && state && <p className="text-meta text-warn">{copy.sourceUnavailable}</p>}
    {failure && <p role="alert" className="break-words text-meta text-bad">{failure.path}: {failure.message}</p>}
    {watcher?.error_code && <p role="alert" className="text-meta text-bad">{copy.publicationFailed}</p>}
    {reload?.error_present && <p role="alert" className="text-meta text-bad">{copy.reloadFailed}</p>}
    {groups.map(({ label, paths }) => paths.length > 0 && <div key={label} className="rounded-lg border border-border bg-bg/25 p-3"><strong className="text-meta text-text">{label}</strong><p className="mt-1 break-words font-mono text-micro text-text-muted">{paths.join(", ")}</p></div>)}
    <p className="text-micro text-text-faint">{copy.scope}</p>
    {groups[1].paths.length > 0 && <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3"><p className="max-w-xl text-meta text-text-muted">{copy.savedOnly}</p><Button variant="secondary" onClick={onReload} disabled={readOnly || !canReload || pending}>{s.server.config.reloadNow}</Button></div>}
    {readOnly && <p className="text-meta text-warn">{errorMessage(s, "read_only")}</p>}
  </Card></section>;
}
