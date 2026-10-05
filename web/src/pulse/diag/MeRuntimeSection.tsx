import { fill, formatNumber, type Dict } from "../../i18n";
import { cn } from "../../lib/cn";
import type { RuntimeGates, RuntimeMePoolState, RuntimeMeQuality, RuntimeMeSelftest } from "../../realtime/topics";
import { formatRaw as diagnosticRaw } from "../formatting";
import { SectionHeading } from "./SectionHeading";
import { TechnicalSection } from "./TechnicalSection";
export function RuntimePanel({
  gates,
  pool,
  quality,
  selftest,
  runtimeSettings,
  s,
}: {
  gates: RuntimeGates | null;
  pool: RuntimeMePoolState | undefined;
  quality: RuntimeMeQuality | undefined;
  selftest: RuntimeMeSelftest | undefined;
  runtimeSettings: Record<string, unknown> | undefined;
  s: Dict;
}) {
  const v = s.details.pages.me.view;
  const drainOpen = quality?.drain_gate.route_quorum_ok && quality.drain_gate.redundancy_ok;
  const cards = [
    [
      v.admission,
      gates?.accepting_new_connections ? v.accepting : v.notAccepting,
      gates?.accepting_new_connections ? v.ready : v.blocked,
      gates?.accepting_new_connections ? "ok" : "warn",
    ],
    [
      v.routeMode,
      gates?.route_mode ?? "—",
      gates?.reroute_active ? v.rerouteActive : v.ready,
      gates?.reroute_active ? "warn" : "ok",
    ],
    [
      v.fallback,
      gates?.me2dc_fallback_enabled ? v.allowed : v.disabled,
      `${v.fastFallback}: ${gates?.me2dc_fast_enabled ? v.yes : v.no}`,
      "ok",
    ],
    [
      v.drainGate,
      quality ? (drainOpen ? v.open : v.blocked) : "—",
      quality?.drain_gate.block_reason ?? "—",
      drainOpen ? "ok" : "warn",
    ],
  ] as const;
  const lifecycle = [
    [
      v.activeGeneration,
      pool ? `#${formatNumber(s, pool.generations.active_generation)}` : "—",
      v.activeGeneration,
    ],
    [
      v.warmGeneration,
      pool?.generations.warm_generation
        ? `#${formatNumber(s, pool.generations.warm_generation)}`
        : v.none,
      pool?.hardswap.pending ? v.hardswapPending : v.hardswapIdle,
    ],
    [
      v.draining,
      pool ? formatNumber(s, pool.writers.draining) : "—",
      fill(v.generationsTemplate, { count: formatNumber(s, pool?.generations.draining_generations.length ?? 0) }),
    ],
    [
      v.refillInflight,
      pool ? formatNumber(s, pool.refill.inflight_endpoints_total) : "—",
      `${pool?.refill.inflight_dc_total ?? 0} DC`,
    ],
  ] as const;
  const tests = [
    [
      "KDF",
      selftest?.kdf.state ?? "—",
      selftest
        ? `${formatNumber(s, selftest.kdf.ewma_errors_per_min)} ${s.details.value.perMinute} · ${v.threshold} ${formatNumber(s, selftest.kdf.threshold_errors_per_min)}`
        : "—",
    ],
    [
      v.clockSkew,
      selftest?.timeskew.state ?? "—",
      selftest?.timeskew.max_skew_secs_15m === null ||
      selftest?.timeskew.max_skew_secs_15m === undefined
        ? "—"
        : `${formatNumber(s, selftest.timeskew.max_skew_secs_15m)} ${s.details.value.seconds} / 15 ${s.details.value.minutes}`,
    ],
    [v.ipv4, selftest?.ip.v4?.state ?? "—", selftest?.ip.v4?.addr ?? "—"],
    [v.ipv6, selftest?.ip.v6?.state ?? "—", selftest?.ip.v6?.addr ?? "—"],
    [v.pid, selftest?.pid.state ?? "—", selftest ? formatNumber(s, selftest.pid.pid) : "—"],
    [
      v.socksBnd,
      selftest?.bnd ? `${selftest.bnd.addr_state} / ${selftest.bnd.port_state}` : "—",
      selftest?.bnd?.last_addr ?? v.notUsed,
    ],
  ] as const;

  return (
    <div data-testid="me-runtime">
      <section className="border-b border-border px-4 py-5 sm:px-5">
        <SectionHeading level={2} variant="compact" kicker={v.runtimeGates} title={v.whatNow} meta={v.operationalFlags} />
        <div className="mt-4 grid overflow-hidden rounded-xl border border-border sm:grid-cols-2 lg:grid-cols-4">
          {cards.map(([label, value, detail, tone]) => (
            <div
              key={label}
              data-runtime-gate
              className="border-b border-r border-border px-3 py-3"
            >
              <span className="text-micro text-text-muted">{label}</span>
              <strong
                className={cn("mt-1 block text-h3", tone === "warn" ? "text-warn" : "text-ok")}
              >
                {value}
              </strong>
              <small className="text-micro text-text-faint">{detail}</small>
            </div>
          ))}
        </div>
      </section>
      <section className="border-b border-border px-4 py-5 sm:px-5">
        <SectionHeading level={2} variant="compact" kicker={v.poolLifecycle} title={v.generationsAndRefill} />
        <div className="mt-4 grid overflow-hidden rounded-xl border border-border sm:grid-cols-2 lg:grid-cols-4">
          {lifecycle.map(([label, value, detail]) => (
            <div
              key={label}
              data-runtime-lifecycle
              className="border-b border-r border-border px-3 py-3"
            >
              <span className="text-micro text-text-muted">{label}</span>
              <strong className="mt-1 block text-h3 tabular-nums text-text">{value}</strong>
              <small className="text-micro text-text-faint">{detail}</small>
            </div>
          ))}
        </div>
      </section>
      <section className="border-b border-border px-4 py-5 sm:px-5">
        <SectionHeading level={2} variant="compact" kicker={v.selftest} title={v.environment} />
        <div className="mt-4 grid overflow-hidden rounded-xl border border-border sm:grid-cols-2">
          {tests.map(([label, value, detail]) => {
            const okay = /^(ok|good|non-one)$/i.test(value);
            return (
              <div
                key={label}
                data-selftest
                className="flex items-start justify-between gap-3 border-b border-r border-border px-3 py-3"
              >
                <div>
                  <span className="block text-meta text-text-muted">{label}</span>
                  <small className="mt-0.5 block break-all text-micro text-text-faint">
                    {detail}
                  </small>
                </div>
                <strong
                  className={okay ? "text-ok" : value === "—" ? "text-text-muted" : "text-warn"}
                >
                  {value}
                </strong>
              </div>
            );
          })}
        </div>
      </section>
      <TechnicalSection className="group px-4 py-4 sm:px-5" data-testid="me-runtime-settings" title={v.runtimeSettings} description={v.runtimeSettingsDescription}>
        <dl className="mt-4 grid border-t border-border sm:grid-cols-2 xl:grid-cols-3">
          {Object.entries(runtimeSettings ?? {})
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([label, value]) => (
              <div
                key={label}
                data-runtime-setting
                className="min-w-0 border-b border-r border-border px-3 py-3"
              >
                <dt className="truncate font-mono text-micro text-text-muted" title={label}>
                  {label}
                </dt>
                <dd className="mt-1 break-all text-meta font-semibold text-text">
                  {diagnosticRaw(value, s, { boolean: "raw" })}
                </dd>
              </div>
            ))}
          {!runtimeSettings && (
            <p className="py-5 text-meta text-text-muted">{v.sourceUnavailable}</p>
          )}
        </dl>
      </TechnicalSection>
    </div>
  );
}
