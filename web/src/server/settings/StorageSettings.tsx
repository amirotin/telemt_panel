import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage, useStrings } from "../../i18n";
import { formatBytes } from "../../lib/format";
import { apiErrorMessage } from "../../people/apiError";
import { Button } from "../../ui/Button";
import { ConfirmView } from "../../ui/ConfirmView";
import { ErrorState } from "../../ui/ErrorState";
import { Sheet } from "../../ui/Sheet";
import { Skeleton } from "../../ui/Skeleton";
import { Toggle } from "../../ui/Toggle";
import {
  IconActivity,
  IconJournal,
  IconPeople,
  IconShield,
  IconTraffic,
  IconWarning,
  IconWrench,
} from "../../ui/icons";
import { pushToast } from "../../ui/Toast";
import {
  getStorageSettingsOptions,
  getStorageSettingsQueryKey,
  purgeStorageHistoryMutation,
  putStorageSettingsMutation,
  resetAllUserTrafficMutation,
} from "../../lib/api/generated/@tanstack/react-query.gen";
import type {
  StorageCategory,
  StoragePolicy,
  StorageSettings as StorageSettingsData,
} from "../../lib/api/generated/types.gen";
import { retentionReductions, sameStoragePolicies } from "./storage.helpers";
import { invalidateTrafficQueries } from "../../traffic/trafficInvalidation";

const retentionOptions = [1, 3, 7, 14, 30, 90, 180, 365, 730];

const categoryIcons: Record<StorageCategory, typeof IconActivity> = {
  technical: IconActivity,
  events: IconJournal,
  audit: IconShield,
  connection_issues: IconWarning,
  traffic: IconTraffic,
  user_traffic: IconPeople,
  user_ip_history: IconPeople,
  diagnostics: IconWrench,
};

export function StorageSettings() {
  const s = useStrings();
  const queryClient = useQueryClient();
  const query = useQuery(getStorageSettingsOptions());
  const [draft, setDraft] = useState<{
    source: StorageSettingsData | null;
    policies: StoragePolicy[];
  }>({ source: null, policies: [] });
  const [purgeCategory, setPurgeCategory] = useState<StorageCategory | null>(null);
  const [resetTrafficOpen, setResetTrafficOpen] = useState(false);
  const [pendingPolicies, setPendingPolicies] = useState<StoragePolicy[] | null>(null);
  const policies =
    draft.source ? draft.policies : (query.data?.policies ?? []);

  function setPolicies(next: StoragePolicy[] | ((current: StoragePolicy[]) => StoragePolicy[])) {
    if (!query.data) return;
    const current = draft.source ? draft.policies : query.data.policies;
    setDraft({
      source: query.data,
      policies: typeof next === "function" ? next(current) : next,
    });
  }

  const saveMutation = useMutation({
    ...putStorageSettingsMutation(),
    onSuccess: async () => {
      setPendingPolicies(null);
      pushToast(s.server.settings.storageSaved, "ok");
      await queryClient.invalidateQueries({ queryKey: getStorageSettingsQueryKey() });
      setDraft({ source: null, policies: [] });
    },
    onError: (error) => pushToast(apiErrorMessage(error, s), "error"),
  });
  const purgeMutation = useMutation({
    ...purgeStorageHistoryMutation(),
    onSuccess: async () => {
      setPurgeCategory(null);
      pushToast(s.server.settings.storagePurged, "ok");
      await queryClient.invalidateQueries({ queryKey: getStorageSettingsQueryKey() });
    },
    onError: (error) => pushToast(apiErrorMessage(error, s), "error"),
  });
  const resetTrafficMutation = useMutation({
    ...resetAllUserTrafficMutation(),
    onSuccess: async () => {
      setResetTrafficOpen(false);
      pushToast(s.server.settings.storageTrafficResetDone, "ok");
      await invalidateTrafficQueries(queryClient);
    },
    onError: (error) => pushToast(apiErrorMessage(error, s), "error"),
  });

  const dirty = query.data ? !sameStoragePolicies(policies, query.data.policies) : false;
  const records = useMemo(
    () =>
      new Map(query.data?.stats.categories.map((entry) => [entry.category, entry.records]) ?? []),
    [query.data],
  );
  const activeCount = policies.filter((policy) => policy.enabled).length;
  const totalRecords = [...records.values()].reduce((total, count) => total + count, 0);
  const selectedCopy = purgeCategory ? s.server.settings.storageCategories[purgeCategory] : null;
  const trafficEntities = query.data?.stats.categories.find((entry) => entry.category === "user_traffic")?.entities ?? 0;

  function updatePolicy(category: StorageCategory, patch: Partial<StoragePolicy>) {
    setPolicies((current) =>
      current.map((policy) => (policy.category === category ? { ...policy, ...patch } : policy)),
    );
  }

  function save() {
    if (retentionReductions(query.data?.policies ?? [], policies).length > 0) {
      setPendingPolicies(policies.map((p) => ({ ...p })));
    } else {
      saveMutation.mutate({ body: { policies } });
    }
  }

  if (query.isPending) {
    return <Skeleton className="h-[420px] w-full rounded-xl" />;
  }
  if (query.isError || !query.data) {
    return (
      <section className="rounded-xl bg-surface p-4">
        <ErrorState message={errorMessage(s, "internal_error")} onRetry={() => query.refetch()} />
      </section>
    );
  }

  return (
    <section
      data-testid="settings-storage"
      className="overflow-hidden rounded-xl bg-surface"
      aria-labelledby="storage-title"
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
        <div className="max-w-2xl">
          <span className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-accent">
            {s.server.settings.storageEyebrow}
          </span>
          <h2 id="storage-title" className="mt-1 text-[18px] font-bold text-text">
            {s.server.settings.storageTitle}
          </h2>
          <p className="mt-1.5 text-[12px] leading-relaxed text-text-muted">
            {s.server.settings.storageNote}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={
              query.data.stats.durable
                ? "rounded-full bg-ok/12 px-2.5 py-1.5 text-[10px] font-bold text-ok"
                : "rounded-full bg-warning/12 px-2.5 py-1.5 text-[10px] font-bold text-warning-text"
            }
          >
            {query.data.stats.driver === "sqlite" ? "SQLite" : "RAM"}
          </span>
          <Button
            size="sm"
            disabled={!dirty || saveMutation.isPending}
            onClick={save}
          >
            {saveMutation.isPending
              ? s.server.settings.storageSaving
              : s.server.settings.storageSave}
          </Button>
        </div>
      </header>

      {(!query.data.stats.durable || !query.data.state_durable) && (
        <div className="flex gap-3 border-b border-warning/25 bg-warning/8 px-4 py-3 text-[11px] leading-relaxed text-text-muted sm:px-5">
          <IconWarning className="mt-0.5 shrink-0 text-warning-text" aria-hidden="true" />
          <span className="space-y-1">
            {!query.data.stats.durable && (
              <span className="block">{s.server.settings.storageMemoryWarning}</span>
            )}
            {!query.data.state_durable && (
              <span className="block">{s.server.settings.storageStateVolatileWarning}</span>
            )}
          </span>
        </div>
      )}

      <dl className="grid grid-cols-3 divide-x divide-border border-b border-border">
        <div className="min-w-0 px-3 py-3 sm:px-5">
          <dt className="text-[9px] font-extrabold uppercase tracking-[0.08em] text-text-faint">
            {s.server.settings.storageSize}
          </dt>
          <dd className="mt-1 truncate font-mono text-[16px] font-bold text-text">
            {formatBytes(query.data.stats.database_bytes, s)}
          </dd>
        </div>
        <div className="min-w-0 px-3 py-3 sm:px-5">
          <dt className="text-[9px] font-extrabold uppercase tracking-[0.08em] text-text-faint">
            {s.server.settings.storageActive}
          </dt>
          <dd className="mt-1 font-mono text-[16px] font-bold text-text">
            {activeCount}/{policies.length}
          </dd>
        </div>
        <div className="min-w-0 px-3 py-3 sm:px-5">
          <dt className="text-[9px] font-extrabold uppercase tracking-[0.08em] text-text-faint">
            {s.server.settings.storageRecords}
          </dt>
          <dd className="mt-1 truncate font-mono text-[16px] font-bold text-text">
            {new Intl.NumberFormat().format(totalRecords)}
          </dd>
        </div>
      </dl>

      <div className="grid gap-px bg-border md:grid-cols-2">
        {policies.map((policy) => {
          const copy = s.server.settings.storageCategories[policy.category];
          const Icon = categoryIcons[policy.category];
          const count = records.get(policy.category) ?? 0;
          const mandatory = policy.category === "user_ip_history";
          return (
            <article key={policy.category} aria-labelledby={`storage-${policy.category}-title`} className="bg-surface px-4 py-4 sm:px-5">
              <div className="flex items-start gap-3">
                <span
                  className={
                    policy.enabled
                      ? "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent"
                      : "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-text-faint"
                  }
                  aria-hidden="true"
                >
                  <Icon />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 id={`storage-${policy.category}-title`} className="text-[13px] font-bold text-text">{copy.title}</h3>
                      <span className="mt-0.5 block text-[10px] text-text-faint">
                        {new Intl.NumberFormat().format(count)}{" "}
                        {s.server.settings.storageRecordsShort}
                      </span>
                    </div>
                    <Toggle
                      checked={policy.enabled}
                      disabled={mandatory}
                      onChange={(enabled) => updatePolicy(policy.category, { enabled })}
                      aria-label={copy.title}
                    />
                  </div>
                  <p className="mt-2 min-h-[34px] text-[11px] leading-relaxed text-text-muted">
                    {copy.note}
                  </p>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-end justify-between gap-2 border-t border-border pt-3">
                <label className="min-w-[150px] flex-1">
                  <span className="mb-1 block text-[9px] font-extrabold uppercase tracking-[0.08em] text-text-faint">
                    {s.server.settings.storageRetention}
                  </span>
                  <select
                    aria-label={`${s.server.settings.storageRetention}: ${copy.title}`}
                    value={policy.retention_days}
                    disabled={!policy.enabled}
                    onChange={(event) =>
                      updatePolicy(policy.category, {
                        retention_days: Number(event.target.value),
                      })
                    }
                    className="h-10 w-full rounded-lg border border-border bg-surface-2 px-3 text-[12px] font-semibold text-text outline-none focus:border-accent disabled:opacity-50"
                  >
                    {[...new Set([...retentionOptions, policy.retention_days])].sort((a, b) => a - b).map((days) => (
                      <option key={days} value={days}>
                        {s.server.settings.storageDays.replace("{count}", String(days))}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex flex-wrap justify-end gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={count === 0}
                    onClick={() => setPurgeCategory(policy.category)}
                  >
                    {s.server.settings.storageClear}
                  </Button>
                  {policy.category === "user_traffic" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={trafficEntities === 0}
                      onClick={() => setResetTrafficOpen(true)}
                    >
                      {s.server.settings.storageTrafficReset}
                    </Button>
                  )}
                </div>
              </div>
              {mandatory && (
                <small className="mt-2 block text-[10px] text-text-faint">
                  {s.server.settings.storageIPRequired}
                </small>
              )}
              {!policy.enabled && count > 0 && (
                <small className="mt-2 block text-[10px] text-warning-text">
                  {s.server.settings.storageKept}
                </small>
              )}
            </article>
          );
        })}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-2/45 px-4 py-3 sm:px-5">
        <p className="max-w-2xl text-[10px] leading-relaxed text-text-faint">
          {s.server.settings.storageFooter}
        </p>
        <Button
          size="sm"
          disabled={!dirty || saveMutation.isPending}
          onClick={save}
        >
          {saveMutation.isPending ? s.server.settings.storageSaving : s.server.settings.storageSave}
        </Button>
      </footer>

      <Sheet
        open={pendingPolicies !== null}
        onClose={() => { if (!saveMutation.isPending) setPendingPolicies(null); }}
        title={s.server.settings.storageReduceTitle}
      >
        <ConfirmView description={s.server.settings.storageReduceNote + " " + retentionReductions(query.data.policies, pendingPolicies ?? []).map((p) =>
          s.server.settings.storageCategories[p.category].title + ": " + query.data.policies.find((old) => old.category === p.category)?.retention_days + " → " + p.retention_days
        ).join("; ")}
          confirmLabel={s.server.settings.storageSave} danger pending={saveMutation.isPending}
          onCancel={() => setPendingPolicies(null)}
          onConfirm={() => { if (pendingPolicies) saveMutation.mutate({ body: { policies: pendingPolicies, confirm_retention_reduction: true } }); }} />
      </Sheet>
      <Sheet
        open={purgeCategory !== null}
        onClose={() => setPurgeCategory(null)}
        eyebrow={s.server.settings.storageClearEyebrow}
        title={s.server.settings.storageClearTitle}
        subtitle={selectedCopy?.title}
      >
        <ConfirmView
          description={s.server.settings.storageClearConfirm.replace(
            "{category}",
            selectedCopy?.title ?? "",
          )}
          confirmLabel={s.server.settings.storageClear}
          danger
          pending={purgeMutation.isPending}
          onCancel={() => setPurgeCategory(null)}
          onConfirm={() => {
            if (purgeCategory) {
              purgeMutation.mutate({ body: { category: purgeCategory, confirm: true } });
            }
          }}
        />
      </Sheet>
      <Sheet
        open={resetTrafficOpen}
        onClose={() => setResetTrafficOpen(false)}
        eyebrow={s.server.settings.storageClearEyebrow}
        title={s.server.settings.storageTrafficResetTitle}
      >
        <ConfirmView
          description={s.server.settings.storageTrafficResetConfirm}
          confirmLabel={s.server.settings.storageTrafficReset}
          danger
          pending={resetTrafficMutation.isPending}
          onCancel={() => setResetTrafficOpen(false)}
          onConfirm={() => resetTrafficMutation.mutate({ body: { confirm: true } })}
        />
      </Sheet>
    </section>
  );
}
