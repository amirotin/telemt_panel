import { Link } from "@tanstack/react-router";
import { useStrings } from "../i18n";
import type { User, UserInheritedLimit } from "../lib/api/generated/types.gen";

export function UserPolicySummary({ user }: { user: Pick<User, "limits" | "source_deny" | "source_deny_status"> }) {
  const s = useStrings(), copy = s.accessPolicy;
  const describe = (limit: UserInheritedLimit) => `${limit.value ?? copy.unlimited} · ${limit.origin === "global_default" ? copy.inherited : limit.origin === "user_override" ? copy.override : copy.unlimited}`;
  const status = user.source_deny_status;
  return <div className="grid min-w-0 gap-3 text-meta" data-testid="user-policy-summary">
    {user.limits && <dl className="grid gap-2 rounded-xl bg-bg p-3">
      {(["max_tcp_conns", "max_unique_ips"] as const).map(key => <div key={key} className="grid gap-1">
        <dt className="font-semibold text-text">{key === "max_tcp_conns" ? copy.tcp : copy.ips}</dt>
        <dd className="text-text-muted">{copy.desired}: {describe(user.limits!.desired[key])}</dd>
        <dd className="text-micro text-text-faint">{copy.effective}: {user.limits!.effective ? describe(user.limits!.effective[key]) : copy.unknown}</dd>
      </div>)}
    </dl>}
    {status && <div className="grid gap-2 rounded-xl border border-border p-3">
      <strong>{copy.sourceDeny}</strong>
      <p className="break-all font-mono text-micro">{copy.desired}: {user.source_deny?.join(", ") || copy.noDenies}</p>
      <p className="break-all font-mono text-micro text-text-muted">{copy.effective}: {status.effective === null ? copy.unknown : status.effective.join(", ") || copy.noDenies}</p>
      <p className={status.runtime_reload_required ? "text-warning-text" : "text-text-muted"}>{status.runtime_reload_required === null ? copy.reloadUnknown : status.runtime_reload_required ? copy.reloadRequired : copy.reloadCurrent}</p>
      {status.runtime_reload_required !== false && <Link to="/server/config" className="inline-flex min-h-11 items-center text-accent underline">{copy.reloadLink}</Link>}
    </div>}
  </div>;
}
