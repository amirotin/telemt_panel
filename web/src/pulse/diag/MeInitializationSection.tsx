import { fill, formatNumber, type Dict } from "../../i18n";
import { cn } from "../../lib/cn";
import type { RuntimeInitialization, RuntimeInitializationComponent } from "../../realtime/topics";
import { StatePill, type State } from "../../ui/StatePill";
import { formatDiagnosticDuration } from "../formatting";
import { SectionHeading } from "./SectionHeading";
function formatDurationMs(value: number | null, s: Dict): string {
  return formatDiagnosticDuration(value, s, { inputUnit: "milliseconds", unit: value !== null && value >= 60_000 ? "minutes" : value !== null && value >= 1000 ? "seconds" : "milliseconds", precision: value !== null && value >= 1000 ? 1 : 3 });
}

function formatAge(seconds: number | null, s: Dict): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—";
  return formatDiagnosticDuration(seconds, s, { inputUnit: "seconds", minimumUnit: "seconds", precision: 0, rounding: seconds < 60 ? "round" : "floor" });
}

interface InitGroup {
  id: string;
  label: string;
  components: RuntimeInitializationComponent[];
}

function initializationGroups(initialization: RuntimeInitialization, s: Dict): InitGroup[] {
  const v = s.details.pages.me.view;
  const specs: Array<[string, string, string[]]> = [
    ["config", v.initConfig, ["config_load"]],
    [
      "services",
      v.initServices,
      [
        "tracing_init",
        "api_bootstrap",
        "tls_front_bootstrap",
        "listeners_bind",
        "config_watcher_start",
        "metrics_start",
        "runtime_ready",
      ],
    ],
    ["network", v.initNetwork, ["network_probe"]],
    [
      "secret",
      v.initSecret,
      ["me_secret_fetch", "me_proxy_config_fetch_v4", "me_proxy_config_fetch_v6"],
    ],
    ["pool", v.initPool, ["me_pool_construct", "me_pool_init_stage1"]],
    ["optional", v.initOptional, ["me_connectivity_ping", "dc_connectivity_ping"]],
  ];
  return specs.map(([id, label, ids]) => ({
    id,
    label,
    components: initialization.components.filter((item) => ids.includes(item.id)),
  }));
}

function initializationGroupState(group: InitGroup): { tone: State; status: string } {
  const statuses = group.components.map((item) => item.status.toLowerCase());
  if (statuses.some((status) => /fail|error/.test(status)))
    return { tone: "error", status: "failed" };
  if (statuses.length > 0 && statuses.every((status) => status === "skipped"))
    return { tone: "muted", status: "skipped" };
  if (statuses.some((status) => !["ready", "skipped", "complete", "completed"].includes(status)))
    return { tone: "warn", status: "in-progress" };
  return { tone: "ok", status: "ready" };
}

export function InitializationPanel({
  initialization,
  nowMs,
  s,
}: {
  initialization: RuntimeInitialization | null;
  nowMs: number;
  s: Dict;
}) {
  const v = s.details.pages.me.view;
  if (!initialization)
    return (
      <p className="px-5 py-12 text-center text-meta text-text-muted">{v.sourceUnavailable}</p>
    );
  const groups = initializationGroups(initialization, s);
  const ready = initialization.status.toLowerCase() === "ready";
  const readyCount = initialization.components.filter(
    (item) => item.status.toLowerCase() === "ready",
  ).length;
  const skippedCount = initialization.components.filter(
    (item) => item.status.toLowerCase() === "skipped",
  ).length;
  const age = nowMs / 1000 - initialization.started_at_epoch_secs;
  const readyDuration =
    initialization.ready_at_epoch_secs === undefined
      ? null
      : (initialization.ready_at_epoch_secs - initialization.started_at_epoch_secs) * 1000;

  return (
    <div
      className="grid lg:grid-cols-[minmax(280px,0.78fr)_minmax(0,1.22fr)]"
      data-testid="me-initialization"
    >
      <section className="border-b border-border px-4 py-5 sm:px-5 lg:border-b-0 lg:border-r">
        <SectionHeading level={2} variant="compact" kicker={v.lastStart} title={ready ? v.proxyReady : v.proxyNotReady} />
        <div
          className={cn(
            "mt-5 flex items-center gap-3 rounded-xl border px-4 py-4",
            ready ? "border-ok/25 bg-ok/8" : "border-warn/25 bg-warn/8",
          )}
        >
          <span
            className={cn(
              "grid h-10 w-10 place-items-center rounded-full text-xl",
              ready ? "bg-ok/15 text-ok" : "bg-warn/15 text-warn",
            )}
          >
            {ready ? "✓" : "…"}
          </span>
          <div>
            <strong className="block text-h3 text-text">
              {ready ? v.completed : v.inProgress}
            </strong>
            <span className="text-micro text-text-muted">
              {v.transportMode}: {initialization.transport_mode}
            </span>
          </div>
        </div>
        <dl className="mt-4 grid grid-cols-2 overflow-hidden rounded-xl border border-border">
          {[
            [v.meReadiness, `${formatNumber(s, initialization.me.progress_pct)}%`],
            [
              v.initAttempt,
              `${formatNumber(s, initialization.me.init_attempt)} · ${initialization.me.retry_limit}`,
            ],
            [
              v.components,
              fill(v.componentStatesTemplate, { ready: formatNumber(s, readyCount), skipped: formatNumber(s, skippedCount) }),
            ],
            [v.started, formatAge(age, s)],
            [v.completed, formatDurationMs(readyDuration, s)],
            [v.state, initialization.current_stage],
          ].map(([label, value]) => (
            <div key={label} data-init-fact className="border-b border-r border-border px-3 py-3">
              <dt className="text-micro text-text-muted">{label}</dt>
              <dd className="mt-1 break-all text-meta font-semibold text-text">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 flex gap-2 text-micro leading-relaxed text-text-muted">
          <span className="text-accent">i</span>
          {v.ageVsDuration}
        </p>
      </section>
      <section className="px-4 py-5 sm:px-5">
        <SectionHeading level={2} variant="compact"
          kicker={v.criticalPath}
          title={v.startupSequence}
          meta={`${initialization.components.length} · ${v.groupedComponents}`}
        />
        <div className="relative mt-5 ml-2 border-l border-border pl-5">
          {groups.map((group) => {
            const state = initializationGroupState(group);
            const duration = group.components.reduce(
              (total, item) => total + (item.duration_ms ?? 0),
              0,
            );
            const details = group.components
              .map((item) => item.details)
              .filter(Boolean)
              .join(" · ");
            const label =
              state.status === "ready"
                ? v.completed
                : state.status === "skipped"
                  ? v.skipped
                  : state.status === "failed"
                    ? v.failed
                    : v.inProgress;
            return (
              <div
                key={group.id}
                className="relative grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-border py-3 first:pt-0 last:border-b-0"
                data-init-group={group.id}
              >
                <i
                  className={cn(
                    "absolute -left-[25px] top-4 h-2 w-2 rounded-full ring-4 ring-surface",
                    state.tone === "ok"
                      ? "bg-ok"
                      : state.tone === "error"
                        ? "bg-error"
                        : state.tone === "warn"
                          ? "bg-warn"
                          : "bg-text-faint",
                  )}
                />
                <div className="min-w-0">
                  <strong className="text-meta text-text">{group.label}</strong>
                  <span className="mt-0.5 block text-micro leading-relaxed text-text-muted">
                    {details || label}
                  </span>
                </div>
                <div className="text-right">
                  <StatePill state={state.tone}>{label}</StatePill>
                  <time className="mt-1 block text-micro tabular-nums text-text-muted">
                    {formatDurationMs(duration, s)}
                  </time>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
