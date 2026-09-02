import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "../lib/cn";
import { useStrings } from "../i18n";
import {
  getTelemtWebAccessOptions,
  getTelemtWebAccessQueryKey,
  putTelemtUserWebAccessMutation,
} from "../lib/api/generated/@tanstack/react-query.gen";
import type { WebUserAccessProfile } from "../lib/api/generated/types.gen";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Sheet } from "../ui/Sheet";
import { Skeleton } from "../ui/Skeleton";
import { pushToast } from "../ui/Toast";
import { IconGlobe, IconPlus, IconTrash } from "../ui/icons";
import { apiErrorMessage } from "./apiError";
import { hasDuplicateWebProfiles, webProfilesForUser } from "./webAccess.helpers";

export function WebAccessPanel({ username }: { username: string }) {
  const s = useStrings();
  const query = useQuery(getTelemtWebAccessOptions());
  const [editing, setEditing] = useState(false);

  if (query.isPending) return <Skeleton className="h-28 w-full rounded-xl" />;

  if (query.isError) {
    return (
      <div className="rounded-xl border border-border bg-bg/35 px-3.5 py-3 text-meta leading-relaxed text-text-muted">
        <strong className="block text-sm text-text">{s.people.webAccess.title}</strong>
        <span>{s.people.webAccess.unavailable}</span>
      </div>
    );
  }

  const profiles = webProfilesForUser(query.data, username);
  const vhosts = query.data.vhosts;

  return (
    <>
      <div className="overflow-hidden rounded-xl border border-border bg-bg/30">
        <div className="flex items-start gap-3 p-3.5">
          <span className={cn("grid size-10 shrink-0 place-items-center rounded-xl", profiles.length > 0 ? "bg-accent/10 text-accent" : "bg-surface-2 text-text-faint")}>
            <IconGlobe className="size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <strong className="text-sm font-semibold text-text">{s.people.webAccess.title}</strong>
              {!query.data.enabled && <em className="rounded-full bg-warn/10 px-2 py-0.5 text-micro font-bold not-italic text-warn">{s.people.webAccess.disabled}</em>}
            </span>
            <small className="mt-1 block text-meta leading-relaxed text-text-muted">
              {profiles.length === 0
                ? s.people.webAccess.noProfiles
                : s.people.webAccess.profileCount.replace("{count}", String(profiles.length))}
            </small>
          </span>
          <Button size="sm" variant="secondary" disabled={vhosts.length === 0} onClick={() => setEditing(true)}>
            {s.people.webAccess.edit}
          </Button>
        </div>

        {profiles.length > 0 && (
          <div className="divide-y divide-border border-t border-border">
            {profiles.map((profile, index) => (
              <div key={`${profile.vhost}:${profile.secret_mode}:${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-3">
                <span className="min-w-0">
                  <strong className="block truncate text-meta font-semibold text-text">{profile.vhost}</strong>
                  <small className="mt-0.5 block text-micro text-text-faint">{limitsSummary(profile, s.people.webAccess)}</small>
                </span>
                <span className="rounded-full bg-accent/10 px-2 py-1 font-mono text-micro font-bold uppercase text-accent">{profile.secret_mode}</span>
              </div>
            ))}
          </div>
        )}

        {vhosts.length === 0 && <p className="border-t border-border px-3.5 py-3 text-meta text-warn">{s.people.webAccess.noVhosts}</p>}
      </div>

      <WebAccessEditor
        open={editing}
        username={username}
        revision={query.data.revision}
        vhosts={vhosts.map(({ host, public_addr }) => ({ host, publicAddr: public_addr }))}
        initialProfiles={profiles}
        onClose={() => setEditing(false)}
      />
    </>
  );
}

function WebAccessEditor({ open, username, revision, vhosts, initialProfiles, onClose }: {
  open: boolean;
  username: string;
  revision: string;
  vhosts: Array<{ host: string; publicAddr: string }>;
  initialProfiles: WebUserAccessProfile[];
  onClose: () => void;
}) {
  const s = useStrings();
  const queryClient = useQueryClient();
  const [profiles, setProfiles] = useState<WebUserAccessProfile[]>(initialProfiles);
  const openKey = open ? `${username}:${revision}` : null;
  const [lastOpenKey, setLastOpenKey] = useState<string | null>(null);
  if (openKey !== null && openKey !== lastOpenKey) {
    setLastOpenKey(openKey);
    setProfiles(initialProfiles);
  }

  const mutation = useMutation({
    ...putTelemtUserWebAccessMutation(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: getTelemtWebAccessQueryKey() });
      pushToast(s.people.webAccess.saved, "ok");
      onClose();
    },
    onError: (error) => pushToast(apiErrorMessage(error, s), "error"),
  });

  const duplicate = hasDuplicateWebProfiles(profiles);
  const invalid = profiles.some((profile) => !profile.vhost || !validLimit(profile.max_sessions) || !validLimit(profile.max_streams) || !validLimit(profile.max_streams_per_session));
  const nextProfile = findAvailableProfile(vhosts.map((vhost) => vhost.host), profiles);

  function updateProfile(index: number, patch: Partial<WebUserAccessProfile>) {
    setProfiles((current) => current.map((profile, itemIndex) => itemIndex === index ? { ...profile, ...patch } : profile));
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      placement="form"
      eyebrow={s.people.webAccess.eyebrow}
      title={s.people.webAccess.editorTitle}
      subtitle={username}
      className="people-form-dialog"
      headerClassName="people-form-head"
      bodyClassName="people-form-sheet-body"
    >
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (duplicate || invalid || mutation.isPending) return;
          mutation.mutate({
            path: { username },
            headers: { "If-Match": revision },
            body: { profiles },
          });
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 sm:p-5">
          <p className="text-meta leading-relaxed text-text-muted">{s.people.webAccess.editorHint}</p>

          {profiles.length === 0 && (
            <div className="rounded-xl border border-dashed border-border-strong px-4 py-8 text-center">
              <IconGlobe className="mx-auto size-6 text-text-faint" />
              <strong className="mt-2 block text-sm text-text">{s.people.webAccess.noProfiles}</strong>
              <p className="mt-1 text-meta text-text-muted">{s.people.webAccess.noProfilesHint}</p>
            </div>
          )}

          {profiles.map((profile, index) => (
            <article key={index} className="rounded-xl border border-border bg-bg/30 p-3.5 sm:p-4">
              <header className="mb-3 flex items-center justify-between gap-3">
                <span>
                  <span className="block text-micro font-semibold uppercase tracking-wide text-text-faint">{s.people.webAccess.profile} {index + 1}</span>
                  <strong className="mt-0.5 block text-sm text-text">{profile.vhost || s.people.webAccess.chooseVhost}</strong>
                </span>
                <button type="button" className="grid size-11 place-items-center rounded-lg text-text-faint hover:bg-bad/8 hover:text-bad" aria-label={s.people.webAccess.remove} onClick={() => setProfiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}>
                  <IconTrash className="size-4" />
                </button>
              </header>

              <div className="grid gap-3 sm:grid-cols-2">
                <label>
                  <span className="mb-1.5 block text-micro font-semibold text-text-muted">{s.people.webAccess.vhost}</span>
                  <Select value={profile.vhost} onChange={(event) => updateProfile(index, { vhost: event.target.value })}>
                    {vhosts.map((vhost) => <option key={vhost.host} value={vhost.host}>{vhost.host}{vhost.publicAddr ? ` · ${vhost.publicAddr}` : ""}</option>)}
                  </Select>
                </label>
                <label>
                  <span className="mb-1.5 block text-micro font-semibold text-text-muted">{s.people.webAccess.mode}</span>
                  <Select value={profile.secret_mode} onChange={(event) => updateProfile(index, { secret_mode: event.target.value as "plain" | "dd" })}>
                    <option value="plain">{s.people.webAccess.modePlain}</option>
                    <option value="dd">{s.people.webAccess.modeDd}</option>
                  </Select>
                </label>
              </div>

              <details className="mt-3 border-t border-border pt-3">
                <summary className="min-h-11 cursor-pointer select-none py-2 text-meta font-semibold text-text-muted">{s.people.webAccess.limits}</summary>
                <p className="mb-3 text-micro leading-relaxed text-text-faint">{s.people.webAccess.limitsHint}</p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <LimitInput label={s.people.webAccess.maxSessions} value={profile.max_sessions} onChange={(value) => updateProfile(index, { max_sessions: value })} />
                  <LimitInput label={s.people.webAccess.maxStreams} value={profile.max_streams} onChange={(value) => updateProfile(index, { max_streams: value })} />
                  <LimitInput label={s.people.webAccess.maxStreamsPerSession} value={profile.max_streams_per_session} onChange={(value) => updateProfile(index, { max_streams_per_session: value })} />
                </div>
              </details>
            </article>
          ))}

          {duplicate && <p className="rounded-lg border border-warn/20 bg-warn/[0.045] px-3 py-2.5 text-meta text-warn">{s.people.webAccess.duplicate}</p>}

          <Button type="button" variant="secondary" disabled={!nextProfile} onClick={() => nextProfile && setProfiles((current) => [...current, nextProfile])}>
            <IconPlus className="size-4" />{s.people.webAccess.add}
          </Button>
        </div>

        <footer className="flex shrink-0 gap-2 border-t border-border bg-surface px-4 py-3 pb-safe sm:px-5">
          <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>{s.common.cancel}</Button>
          <Button type="submit" className="flex-1" disabled={duplicate || invalid || mutation.isPending}>{mutation.isPending ? s.common.loading : s.common.save}</Button>
        </footer>
      </form>
    </Sheet>
  );
}

function LimitInput({ label, value, onChange }: { label: string; value: number | undefined; onChange: (value: number | undefined) => void }) {
  const s = useStrings();
  return (
    <label>
      <span className="mb-1.5 block min-h-8 text-micro font-semibold leading-tight text-text-muted">{label}</span>
      <Input
        type="number"
        inputMode="numeric"
        min={1}
        value={value ?? ""}
        placeholder={s.people.webAccess.inherited}
        onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
      />
    </label>
  );
}

function validLimit(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value > 0);
}

function findAvailableProfile(vhosts: readonly string[], profiles: readonly WebUserAccessProfile[]): WebUserAccessProfile | null {
  for (const vhost of vhosts) {
    for (const secret_mode of ["plain", "dd"] as const) {
      if (!profiles.some((profile) => profile.vhost === vhost && profile.secret_mode === secret_mode)) return { vhost, secret_mode };
    }
  }
  return null;
}

function limitsSummary(profile: WebUserAccessProfile, copy: { inherited: string; maxSessions: string; maxStreams: string; maxStreamsPerSession: string }): string {
  const values = [
    profile.max_sessions === undefined ? null : `${copy.maxSessions}: ${profile.max_sessions}`,
    profile.max_streams === undefined ? null : `${copy.maxStreams}: ${profile.max_streams}`,
    profile.max_streams_per_session === undefined ? null : `${copy.maxStreamsPerSession}: ${profile.max_streams_per_session}`,
  ].filter((value): value is string => value !== null);
  return values.length === 0 ? copy.inherited : values.join(" · ");
}
