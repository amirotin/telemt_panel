import { formatNumber, useStrings } from "../../i18n";
import type { EffectiveLimits } from "../../realtime/topics";
import { formatRtt } from "../formatting";
import { duration } from "./security.view.helpers";
import { SectionHeading } from "./SectionHeading";
export function LimitsPanel({ limits }: { limits: EffectiveLimits }) {
  const s = useStrings();
  const v = s.details.pages.security.view;
  const t = limits.timeouts;
  const u = limits.upstream;
  const rows = [
    [v.connectAttempts, formatNumber(s, u.connect_retry_attempts), "connect_retry_attempts"],
    [v.backoff, formatRtt(u.connect_retry_backoff_ms, s, { precision: 3 }), "connect_retry_backoff_ms"],
    [v.totalBudget, formatRtt(u.connect_budget_ms, s, { precision: 3 }), "connect_budget_ms"],
    [v.unhealthyThreshold, formatNumber(s, u.unhealthy_fail_threshold), "unhealthy_fail_threshold"],
    [
      v.failfastHardErrors,
      u.connect_failfast_hard_errors ? v.enabled : v.disabled,
      "connect_failfast_hard_errors",
    ],
  ];
  const runtime = [
    [v.configRefresh, duration(s, limits.update_every_secs), "update_every_secs"],
    [v.meReinit, duration(s, limits.me_reinit_every_secs), "me_reinit_every_secs"],
    [v.meForceClose, duration(s, limits.me_pool_force_close_secs), "me_pool_force_close_secs"],
    [v.clientAck, duration(s, t.client_ack_secs), "client_ack_secs"],
    [
      v.meRetryTimeout,
      `${formatNumber(s, t.me_one_retry)} / ${formatRtt(t.me_one_timeout_ms, s, { precision: 3 })}`,
      "me_one_retry / me_one_timeout_ms",
    ],
  ];
  const policy = [
    [v.ipPolicyMode, limits.user_ip_policy.mode, "user_ip_policy.mode"],
    [
      v.ipPolicyLimit,
      formatNumber(s, limits.user_ip_policy.global_each),
      "user_ip_policy.global_each",
    ],
    [
      v.ipPolicyWindow,
      duration(s, limits.user_ip_policy.window_secs),
      "user_ip_policy.window_secs",
    ],
    [
      v.tcpPolicyLimit,
      formatNumber(s, limits.user_tcp_policy.global_each),
      "user_tcp_policy.global_each",
    ],
  ];
  return (
    <section className="p-4 sm:p-5" data-testid="security-limits-panel">
      <SectionHeading level={2} variant="standard" kicker={v.effectiveValues} title={v.connectionBudgets} meta={v.afterDefaults} />
      <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border lg:grid-cols-4">
        <TimeoutStep
          label="Handshake"
          value={duration(s, t.client_handshake_secs)}
          hint={v.handshakeHint}
        />
        <TimeoutStep
          label="Telegram connect"
          value={duration(s, t.tg_connect_secs)}
          hint={v.telegramConnectHint}
        />
        <TimeoutStep
          label="Keepalive"
          value={duration(s, t.client_keepalive_secs)}
          hint={v.keepaliveHint}
        />
        <TimeoutStep
          label="First byte idle"
          value={duration(s, t.client_first_byte_idle_secs)}
          hint={v.firstByteHint}
        />
      </div>
      <div className="mt-5 grid gap-4 xl:grid-cols-3">
        <LimitGroup title={v.upstreamRetries} rows={rows} />
        <LimitGroup title={v.runtimeBudgets} rows={runtime} />
        <LimitGroup title={v.userPolicies} rows={policy} />
      </div>
      <div className="mt-4 flex gap-3 rounded-xl border border-accent/20 bg-accent/5 px-4 py-3">
        <span className="font-bold text-accent">i</span>
        <p className="text-meta leading-relaxed text-text-muted">{v.limitsExplanation}</p>
      </div>
    </section>
  );
}
function TimeoutStep({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="min-w-0 bg-surface p-3.5">
      <span className="block text-micro text-text-faint">{label}</span>
      <strong className="mt-1.5 block text-lg font-bold tabular-nums text-text">{value}</strong>
      <small className="mt-1 block text-micro leading-relaxed text-text-muted">{hint}</small>
    </div>
  );
}
function LimitGroup({ title, rows }: { title: string; rows: string[][] }) {
  return (
    <section className="rounded-xl border border-border bg-bg/25 p-4">
      <h3 className="text-meta font-semibold text-text">{title}</h3>
      <div className="mt-3 divide-y divide-border">
        {rows.map(([label, value, key]) => (
          <div key={key} className="flex items-center justify-between gap-4 py-3">
            <div>
              <span className="block text-meta text-text">{label}</span>
              <small className="block break-all font-mono text-micro text-text-faint">{key}</small>
            </div>
            <strong className="shrink-0 text-meta font-semibold tabular-nums text-text">
              {value}
            </strong>
          </div>
        ))}
      </div>
    </section>
  );
}
