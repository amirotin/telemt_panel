import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCaps } from "../../caps";
import { useStrings } from "../../i18n";
import { getTelemtAccessPolicyOptions, getTelemtAccessPolicyQueryKey } from "../../lib/api/generated/@tanstack/react-query.gen";
import { getTelemtAccessPolicy, patchTelemtAccessPolicy } from "../../lib/api/generated/sdk.gen";
import type { TelemtAccessPolicyState } from "../../lib/api/generated/types.gen";
import { apiErrorCode, apiErrorMessage } from "../../people/apiError";
import { Button } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";
import { policyDraft, policyNumbers, policyPatch, rebasePolicyDraft, type PolicyDraft } from "./policy.helpers";

interface Session { base: TelemtAccessPolicyState; draft: PolicyDraft }

function rebaseDraft(session: Session, fresh: TelemtAccessPolicyState): Session {
  return { base: fresh, draft: rebasePolicyDraft(policyDraft(session.base.desired), session.draft, policyDraft(fresh.desired)) };
}

export function AccessPolicyEditor() {
  const s = useStrings(), copy = s.accessPolicy, caps = useCaps();
  const supported = caps.data?.capabilities.access_policy === true;
  const readOnly = caps.data?.capabilities.read_only === true;
  const queryClient = useQueryClient();
  const query = useQuery({ ...getTelemtAccessPolicyOptions(), enabled: supported, retry: false });
  const [session, setSession] = useState<Session | null>(null);
  const [preview, setPreview] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const baseDraft = session ? policyDraft(session.base.desired) : null;
  const dirty = session && JSON.stringify(session.draft) !== JSON.stringify(baseDraft);
  const failedConflict = ["revision_conflict", "runtime_conflict"].includes(apiErrorCode(failure) ?? "");
  const remoteChanged = !!session && !!query.data && (query.data.revision !== session.base.revision || query.data.runtime.runtime_match !== session.base.runtime.runtime_match);
  const conflict = failedConflict || !!dirty && remoteChanged;
  // Refetches can update an untouched form, but a dirty draft retains its own CAS tokens.
  if (query.data && (!session || !dirty && remoteChanged && !failedConflict)) {
    setSession({ base: query.data, draft: policyDraft(query.data.desired) });
  }
  const mutation = useMutation({
    mutationFn: async (submitted: Session) => {
      const response = await patchTelemtAccessPolicy({
        body: policyPatch(policyDraft(submitted.base.desired), submitted.draft),
        headers: { "If-Match": submitted.base.revision, "If-Runtime-Match": submitted.base.runtime.runtime_match },
      });
      if (response.error) throw response.error;
      if (!response.data) throw new Error("empty response");
      return { confirmed: response.data, submitted };
    },
    onSuccess: ({ confirmed, submitted }) => {
      queryClient.setQueryData(getTelemtAccessPolicyQueryKey(), confirmed);
      setSession(current => {
        if (!current) return { base: confirmed, draft: policyDraft(confirmed.desired) };
        const next = policyDraft(confirmed.desired);
        for (const key of Object.keys(next) as (keyof PolicyDraft)[]) if (current.draft[key] !== submitted.draft[key]) next[key] = current.draft[key];
        return { base: confirmed, draft: next };
      });
      setFailure(null); setSaved(true); setPreview(false);
    },
    onError: error => { setFailure(error); setPreview(false); },
  });
  const busy = refreshing || mutation.isPending;
  let invalid = false, changes = {};
  if (session && baseDraft) {
    try { changes = policyPatch(baseDraft, session.draft); } catch { invalid = true; }
  }
  const hasChanges = Object.keys(changes).length > 0;
  const canSave = supported && !readOnly && !busy && !conflict && !invalid && hasChanges;
  const labels: Record<keyof PolicyDraft, string> = {
    user_max_tcp_conns_global_each: copy.tcp, user_max_unique_ips_global_each: copy.ips,
    user_max_unique_ips_window_secs: copy.window, user_max_unique_ips_mode: copy.mode, cidr_rate_limits: copy.cidr,
  };
  async function refresh(keep: boolean) {
    setRefreshing(true);
    try {
      const result = await getTelemtAccessPolicy();
      if (result.error) throw result.error;
      if (!result.data) throw new Error("empty response");
      const fresh = result.data;
      queryClient.setQueryData(getTelemtAccessPolicyQueryKey(), fresh);
      setSession(current => keep && current ? rebaseDraft(current, fresh) : { base: fresh, draft: policyDraft(fresh.desired) });
      setFailure(null); setSaved(false); setPreview(false);
    } catch (error) { setFailure(error); } finally { setRefreshing(false); }
  }
  const update = (key: keyof PolicyDraft, value: string) => {
    setSession(current => current ? { ...current, draft: { ...current.draft, [key]: value } } : current);
    setSaved(false);
  };
  return <section className="grid min-w-0 gap-4 rounded-2xl border border-border bg-surface p-4 sm:p-5" data-testid="access-policy-editor">
    <header><h2 className="text-lg font-semibold text-text">{copy.title}</h2><p className="mt-1 text-meta text-text-muted">{copy.description}</p></header>
    {!caps.data ? <p className="text-meta text-text-muted">{caps.error ? apiErrorMessage(caps.error, s) : s.common.loading}</p> : !supported ? <p className="text-meta text-text-muted">{copy.unsupported}</p> : <>
      {readOnly && <p className="rounded-xl bg-bg p-3 text-meta text-text-muted">{copy.readonly}</p>}
      {query.error && <p role="alert" className="text-meta text-error">{apiErrorMessage(query.error, s)}</p>}
      {session ? <>
        <fieldset disabled={readOnly || busy} className="grid min-w-0 gap-4 sm:grid-cols-2">
          {policyNumbers.map(key => <label key={key} className="grid gap-1.5 text-meta text-text-muted"><span>{labels[key]}</span><input name={key} className="min-h-11 min-w-0 rounded-xl border border-border bg-bg px-3 text-text" inputMode="numeric" value={session.draft[key]} onChange={event => update(key, event.target.value)} /><small>{copy.effective}: {String(session.base.effective[key])}</small></label>)}
          <label className="grid gap-1.5 text-meta text-text-muted"><span>{copy.mode}</span><select name="user_max_unique_ips_mode" className="min-h-11 min-w-0 rounded-xl border border-border bg-bg px-3 text-text" value={session.draft.user_max_unique_ips_mode} onChange={event => update("user_max_unique_ips_mode", event.target.value)}>{(["active_window", "time_window", "combined"] as const).map(mode => <option key={mode} value={mode}>{copy[mode]}</option>)}</select></label>
          <p className="text-micro leading-relaxed text-text-muted sm:col-span-2">{copy.zero}</p>
          <label className="grid min-w-0 gap-1.5 text-meta text-text-muted sm:col-span-2"><span>{copy.cidr}</span><textarea name="cidr_rate_limits" className="min-h-32 w-full rounded-xl border border-border bg-bg p-3 font-mono text-meta text-text" rows={4} value={session.draft.cidr_rate_limits} spellCheck={false} autoCapitalize="off" onChange={event => update("cidr_rate_limits", event.target.value)} /><small className="leading-relaxed">{copy.cidrHint}</small></label>
        </fieldset>
        {invalid && <p role="alert" className="text-meta text-error">{copy.invalid}</p>}
        {conflict && <div role="alert" className="grid gap-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-meta"><p>{copy.conflict}</p><Button variant="secondary" onClick={() => void refresh(true)} disabled={busy || readOnly || invalid}>{copy.rebase}</Button></div>}
        {!!failure && !failedConflict && <p role="alert" className="text-meta text-error">{apiErrorMessage(failure, s)}</p>}
        {saved && <p role="status" className="rounded-xl bg-success/10 p-3 text-meta text-success-text">{copy.saved}</p>}
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end"><Button variant="secondary" disabled={busy} onClick={() => void refresh(false)}>{dirty ? copy.discard : copy.refresh}</Button><Button disabled={!canSave} onClick={() => setPreview(true)}>{copy.save}</Button></div>
        <Sheet open={preview} onClose={() => setPreview(false)} title={copy.preview}>
          <div className="grid gap-4 p-4"><dl className="grid gap-3">{(Object.keys(changes) as (keyof PolicyDraft)[]).map(key => <div key={key} className="grid gap-1 rounded-xl bg-bg p-3"><dt className="text-meta font-semibold">{labels[key]}</dt><dd className="whitespace-pre-wrap break-all text-meta">{session.draft[key] || copy.noDenies}</dd></div>)}</dl><div className="flex flex-col gap-2"><Button disabled={!canSave} onClick={() => { if (canSave) mutation.mutate(structuredClone(session)); }}>{copy.confirm}</Button><Button variant="secondary" onClick={() => setPreview(false)}>{copy.cancel}</Button></div></div>
        </Sheet>
      </> : <><p className="text-meta text-text-muted">{query.error ? copy.error : s.common.loading}</p><Button variant="secondary" onClick={() => void refresh(false)} disabled={busy}>{copy.refresh}</Button></>}
    </>}
  </section>;
}
