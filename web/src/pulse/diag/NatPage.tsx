import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { formatNumber, useStrings, type Dict } from "../../i18n";
import { cn } from "../../lib/cn";
import { useNow } from "../../people/useNow";
import { useSnapshot } from "../../realtime";
import type {
  RuntimeGates,
  RuntimeNatStun,
  RuntimeNatStunReflection,
  RuntimeTopic,
} from "../../realtime/topics";
import { IconChevronDown } from "../../ui/icons";
import { StatePill, type State } from "../../ui/StatePill";
import { DetailHeader } from "../details-builder/DetailHeader";
import {
  natPageDefinition,
  reflectionAgeSecs,
  STUN_REFLECTION_TTL_SECONDS,
} from "../details-builder/definitions/nat";
import { useDetailSources, type DetailSourceInput } from "../details-builder/sources";
import { resolveGated } from "../widgets/gated";
import { meRouteMode, type MeRouteMode } from "./me.helpers";
import { natMechanismState, type NatMechanismState } from "./nat.helpers";

type NatTab = "overview" | "servers";

function formatAge(seconds: number | null, s: Dict): string {
  const v = s.details.pages.nat.view;
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${formatNumber(s, Math.round(seconds))} ${v.secondsShort}`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest > 0
    ? `${formatNumber(s, minutes)} ${v.minutesShort} ${formatNumber(s, rest)} ${v.secondsShort}`
    : `${formatNumber(s, minutes)} ${v.minutesShort}`;
}

function formatRaw(value: unknown, s: Dict): string {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return formatNumber(s, value);
  return String(value);
}

function stateTone(state: NatMechanismState): State {
  if (state === "fresh") return "ok";
  if (state === "delayed") return "warn";
  if (state === "missing") return "error";
  return "muted";
}

function stateCopy(state: NatMechanismState, s: Dict) {
  const v = s.details.pages.nat.view;
  switch (state) {
    case "fresh":
      return { title: v.freshTitle, detail: v.freshDetail, note: v.freshNote };
    case "delayed":
      return { title: v.delayedTitle, detail: v.delayedDetail, note: v.delayedNote };
    case "missing":
      return { title: v.missingTitle, detail: v.missingDetail, note: v.missingNote };
    case "disabled":
      return { title: v.disabledTitle, detail: v.disabledDetail, note: v.disabledNote };
    case "pending":
      return { title: v.pendingTitle, detail: v.pendingDetail, note: v.pendingNote };
    default:
      return { title: v.staleTitle, detail: v.staleDetail, note: v.staleNote };
  }
}

function SectionHeading({ kicker, title, meta }: { kicker: string; title: string; meta?: string }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div>
        <span className="text-label font-semibold uppercase tracking-[0.12em] text-text-muted">
          {kicker}
        </span>
        <h3 className="mt-1 text-h3 font-semibold text-text">{title}</h3>
      </div>
      {meta && <span className="text-micro text-text-muted">{meta}</span>}
    </header>
  );
}

function RouteState({ mode, gates, s }: { mode: MeRouteMode; gates: RuntimeGates; s: Dict }) {
  const v = s.details.pages.nat.view;
  const fallback = mode === "fallback";
  const facts = [
    [v.activeRoute, "Direct", v.connectionsDirect],
    [
      v.directRole,
      fallback ? v.reserve : v.primary,
      fallback ? v.fallbackActivated : v.selectedByConfig,
    ],
    [
      v.middleEnd,
      fallback ? v.enabledNotReady : v.disabled,
      fallback ? v.primaryUnavailable : v.poolNotCreated,
    ],
    [
      v.natForMe,
      fallback ? v.sourceUnavailable : v.notRequired,
      fallback ? v.sourceUnavailableExplained : v.sourceUnavailableExpected,
    ],
  ];

  return (
    <section className="px-4 py-5 sm:px-5" data-testid="nat-route-state">
      <div
        className={cn(
          "overflow-hidden rounded-xl border",
          fallback ? "border-warn/50 bg-warn-soft/10" : "border-border bg-surface-2",
        )}
      >
        <div className="grid gap-4 border-b border-border px-4 py-5 sm:grid-cols-[52px_minmax(0,1fr)] sm:px-5">
          <span
            className={cn(
              "grid h-12 w-12 place-items-center rounded-xl border text-h2 font-bold",
              fallback
                ? "border-warn/50 bg-warn-soft text-warn"
                : "border-border-strong bg-surface-3 text-text-muted",
            )}
            aria-hidden="true"
          >
            {fallback ? "↘" : "→"}
          </span>
          <div>
            <span className="text-label font-semibold uppercase tracking-[0.12em] text-text-muted">
              {v.activeRoute}
            </span>
            <h3 className="mt-1 text-h2 font-semibold text-text">
              {fallback ? v.fallbackTitle : v.directTitle}
            </h3>
            <p className="mt-2 max-w-3xl text-meta leading-relaxed text-text-muted">
              {fallback ? v.fallbackDetail : v.directDetail}
            </p>
            <strong className={cn("mt-3 block text-meta", fallback ? "text-warn" : "text-text")}>
              {fallback ? v.fallbackNote : v.directNote}
            </strong>
          </div>
        </div>
        <div className="grid sm:grid-cols-2 xl:grid-cols-4">
          {facts.map(([label, value, note]) => (
            <div key={label} className="min-w-0 border-b border-r border-border px-4 py-4">
              <span className="text-micro text-text-muted">{label}</span>
              <strong className="mt-1 block text-h3 font-semibold text-text">{value}</strong>
              <small className="mt-1 block text-micro leading-relaxed text-text-muted">
                {note}
              </small>
            </div>
          ))}
        </div>
        <p className="flex gap-2 px-4 py-4 text-meta leading-relaxed text-text-muted sm:px-5">
          <span className="text-accent">i</span>
          <span>{fallback ? v.fallbackExplanation : v.directExplanation}</span>
        </p>
      </div>
      <input type="hidden" value={gates.route_mode} readOnly />
    </section>
  );
}

function VerdictHero({ nat, s }: { nat: RuntimeNatStun; s: Dict }) {
  const v = s.details.pages.nat.view;
  const state = natMechanismState(nat);
  const tone = stateTone(state);
  const copy = stateCopy(state, s);
  const age = reflectionAgeSecs(nat);
  const v4 = nat.reflection?.v4;
  const v6 = nat.reflection?.v6;
  const live = nat.servers?.live?.length ?? nat.servers?.live_total ?? 0;
  const vitals = [
    [v.ipv4Reflection, v4?.addr ?? v.noData, v.runtimeAddress, false],
    [
      v.ageTtl,
      age === null ? "—" : `${formatAge(age, s)} / 10 ${v.minutesShort}`,
      v.cachedFreshness,
      age !== null && age >= STUN_REFLECTION_TTL_SECONDS,
    ],
    [v.ipv6Reflection, v6?.addr ?? v.noData, v.familyAbsenceNotError, false],
    [v.lastProbe, formatNumber(s, live), v.answeredNotQuorum, state === "delayed"],
  ] as const;

  return (
    <section
      className="grid border-b border-border sm:grid-cols-2 xl:grid-cols-[minmax(340px,1.4fr)_repeat(4,minmax(130px,.55fr))]"
      data-testid="nat-hero"
    >
      <div className="flex min-h-36 items-center gap-4 border-b border-r border-border px-4 py-5 sm:col-span-2 sm:px-5 xl:col-span-1">
        <span
          className={cn(
            "grid h-12 w-12 shrink-0 place-items-center rounded-xl border text-h2 font-bold",
            tone === "ok" && "border-ok/45 bg-ok-soft text-ok",
            tone === "warn" && "border-warn/45 bg-warn-soft text-warn",
            tone === "error" && "border-error/45 bg-error-soft text-error",
            tone === "muted" && "border-border-strong bg-surface-2 text-text-muted",
          )}
        >
          {tone === "ok" ? "✓" : tone === "warn" || tone === "error" ? "!" : "i"}
        </span>
        <div className="min-w-0">
          <span className="text-label font-semibold uppercase tracking-[0.12em] text-text-muted">
            {v.mechanismState}
          </span>
          <h3 className="mt-1 text-h3 font-semibold text-text">{copy.title}</h3>
          <p className="mt-1 text-micro leading-relaxed text-text-muted">{copy.detail}</p>
          <strong
            className={cn(
              "mt-2 block text-micro",
              tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : "text-text-muted",
            )}
          >
            {copy.note}
          </strong>
        </div>
      </div>
      {vitals.map(([label, value, note, warning]) => (
        <div
          key={label}
          className="flex min-h-28 min-w-0 flex-col justify-center border-b border-r border-border px-4 py-4"
        >
          <span className="text-micro text-text-muted">{label}</span>
          <strong
            className={cn(
              "mt-2 break-all font-mono text-[15px] font-bold tabular-nums text-text",
              warning && "text-warn",
            )}
          >
            {value}
          </strong>
          <small className="mt-1 text-micro leading-relaxed text-text-muted">{note}</small>
        </div>
      ))}
    </section>
  );
}

function FlowNode({
  step,
  name,
  value,
  description,
  status,
  tone = "neutral",
}: {
  step: number;
  name: string;
  value: string;
  description: string;
  status: string;
  tone?: "neutral" | "ok" | "warn" | "muted";
}) {
  return (
    <article
      className={cn(
        "relative min-w-0 rounded-xl border bg-surface-2 px-4 py-4",
        tone === "warn" ? "border-warn/45" : "border-border",
        tone === "muted" && "opacity-70",
      )}
      data-nat-flow-node={step}
    >
      <header className="flex items-center justify-between gap-2 text-micro text-text-muted">
        <span>
          {step} · {name}
        </span>
        <b
          className={cn(
            tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : "text-text-muted",
          )}
        >
          {status}
        </b>
      </header>
      <strong className="mt-3 block break-all font-mono text-[15px] font-bold text-text">
        {value}
      </strong>
      <p className="mt-2 text-micro leading-relaxed text-text-muted">{description}</p>
      <i
        className={cn(
          "absolute inset-x-4 bottom-0 h-0.5 rounded-full",
          tone === "warn" ? "bg-warn" : tone === "ok" ? "bg-ok" : "bg-border-strong",
        )}
      />
    </article>
  );
}

function FamilyCard({
  family,
  reflection,
  s,
}: {
  family: "IPv4" | "IPv6";
  reflection?: RuntimeNatStunReflection;
  s: Dict;
}) {
  const v = s.details.pages.nat.view;
  const age = reflection?.age_secs ?? null;
  const warning = age !== null && age >= STUN_REFLECTION_TTL_SECONDS;
  const percent = age === null ? 0 : Math.min(100, (age / STUN_REFLECTION_TTL_SECONDS) * 100);
  return (
    <article
      className={cn(
        "rounded-xl border bg-surface-2 p-4",
        warning ? "border-warn/45" : "border-border",
        !reflection && "opacity-75",
      )}
      data-nat-family={family.toLowerCase()}
    >
      <div className="flex items-center justify-between gap-3">
        <strong className="text-h3 text-text">{family}</strong>
        <span className={cn("text-micro font-semibold", warning ? "text-warn" : "text-text-muted")}>
          {reflection ? (warning ? v.needsRefresh : v.cacheFresh) : v.noReflection}
        </span>
      </div>
      <code className="mt-4 block break-all font-mono text-[15px] font-bold text-text">
        {reflection?.addr ?? v.notReceived}
      </code>
      <p className="mt-2 min-h-10 text-micro leading-relaxed text-text-muted">
        {reflection
          ? v.addressSeenByStun
          : family === "IPv4"
            ? v.endpointNoFamily
            : v.familySeparateState}
      </p>
      <div className="mt-5">
        <div className="flex justify-between text-micro text-text-muted">
          <span>0</span>
          <span>TTL 10 {v.minutesShort}</span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-3">
          <i
            className={cn("block h-full rounded-full", warning ? "bg-warn" : "bg-accent")}
            style={{ width: `${percent}%` }}
          />
        </div>
        <small className="mt-2 block text-micro text-text-muted">
          {age === null ? v.ageUnavailable : `${v.cacheAge}: ${formatAge(age, s)}`}
        </small>
      </div>
    </article>
  );
}

function OverviewPanel({ nat, s }: { nat: RuntimeNatStun; s: Dict }) {
  const v = s.details.pages.nat.view;
  const state = natMechanismState(nat);
  const enabled = state !== "disabled";
  const delayed = state === "delayed" || state === "missing";
  const age = reflectionAgeSecs(nat);
  const primaryReflection = nat.reflection?.v4 ?? nat.reflection?.v6;
  const primaryFamily = nat.reflection?.v4 ? "IPv4" : nat.reflection?.v6 ? "IPv6" : null;
  const servers = nat.servers?.configured?.length ?? 0;
  const live = nat.servers?.live?.length ?? nat.servers?.live_total ?? 0;
  const nodes = [
    {
      name: v.localBind,
      value: v.notExposed,
      description: v.localBindDescription,
      status: v.unknown,
      tone: "muted" as const,
    },
    {
      name: v.stunDiscovery,
      value: enabled ? `${formatNumber(s, servers)} ${v.serversSuffix}` : v.notStarted,
      description: !enabled ? v.autoProbeDisabled : delayed ? v.refreshDelayed : v.parallelProbe,
      status: !enabled ? v.disabled : delayed ? v.refreshDelayedState : v.enabled,
      tone: !enabled ? ("muted" as const) : delayed ? ("warn" as const) : ("ok" as const),
    },
    {
      name: v.reflectionCache,
      value: primaryReflection?.addr ?? v.noCache,
      description:
        age === null
          ? v.familyNotInSnapshot
          : `${primaryFamily ?? "IP"}: ${v.savedAgo} ${formatAge(age, s)}. ${v.ttlTenMinutes}`,
      status: age === null ? v.noData : age >= STUN_REFLECTION_TTL_SECONDS ? v.olderTtl : v.current,
      tone:
        age === null
          ? ("muted" as const)
          : age >= STUN_REFLECTION_TTL_SECONDS
            ? ("warn" as const)
            : ("ok" as const),
    },
    {
      name: v.meAddress,
      value: !enabled
        ? v.dependsOnConfig
        : primaryFamily
          ? `${primaryFamily} ${v.addressPrepared}`
          : v.notDetermined,
      description: !enabled ? v.manualNatPossible : v.reflectionUsage,
      status: !enabled
        ? v.checkConfig
        : delayed
          ? v.readyByCache
          : primaryFamily
            ? v.ready
            : v.noData,
      tone: !enabled || !primaryFamily ? ("muted" as const) : ("ok" as const),
    },
  ];
  const probeRows = [
    [v.autoDiscovery, enabled ? v.enabled : v.disabled, enabled ? "ok" : "muted"],
    [
      v.consecutiveAttempts,
      formatNumber(s, nat.flags.nat_probe_attempts ?? 0),
      delayed ? "warn" : "neutral",
    ],
    [
      v.backoff,
      (nat.stun_backoff_remaining_ms ?? 0) > 0
        ? formatAge(Math.ceil((nat.stun_backoff_remaining_ms ?? 0) / 1_000), s)
        : v.notActive,
      (nat.stun_backoff_remaining_ms ?? 0) > 0 ? "warn" : "neutral",
    ],
    [v.answeredSnapshot, formatNumber(s, live), "neutral"],
  ] as const;

  return (
    <section data-testid="nat-overview">
      <div className="px-4 py-5 sm:px-5">
        <SectionHeading kicker={v.howAddressUsed} title={v.pathTitle} meta={v.pathMeta} />
        <div className="mt-5 grid items-stretch gap-2 lg:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr]">
          {nodes.map((node, index) => (
            <div key={node.name} className="contents">
              <FlowNode step={index + 1} {...node} />
              {index < nodes.length - 1 && (
                <span
                  className="grid place-items-center py-1 text-h3 text-accent lg:px-1 lg:py-0"
                  aria-hidden="true"
                >
                  <span className="rotate-90 lg:rotate-0">→</span>
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="grid border-t border-border lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,.65fr)]">
        <section className="border-b border-r border-border px-4 py-5 sm:px-5">
          <SectionHeading
            kicker={v.byIpFamily}
            title={v.knownAddresses}
            meta={v.portFromReflection}
          />
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <FamilyCard family="IPv4" reflection={nat.reflection?.v4} s={s} />
            <FamilyCard family="IPv6" reflection={nat.reflection?.v6} s={s} />
          </div>
        </section>
        <aside className="px-4 py-5 sm:px-5">
          <SectionHeading kicker={v.probeState} title={v.whatNow} meta={v.notProxyHealth} />
          <dl className="mt-5 overflow-hidden rounded-xl border border-border">
            {probeRows.map(([label, value, tone]) => (
              <div
                key={label}
                className="flex items-center justify-between gap-4 border-b border-border px-3 py-3 last:border-b-0"
              >
                <dt className="text-meta text-text-muted">{label}</dt>
                <dd
                  className={cn(
                    "font-mono text-[15px] font-bold tabular-nums text-text",
                    tone === "warn" && "text-warn",
                    tone === "ok" && "text-ok",
                    tone === "muted" && "text-text-muted",
                  )}
                >
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <p
            className={cn(
              "mt-4 flex gap-2 rounded-lg border border-border bg-surface-2 px-3 py-3 text-micro leading-relaxed text-text-muted",
              delayed && "border-warn/40",
            )}
          >
            <span className={delayed ? "text-warn" : "text-accent"}>i</span>
            <span>
              {delayed ? v.delayedProbeNote : !enabled ? v.disabledProbeNote : v.freshProbeNote}
            </span>
          </p>
        </aside>
      </div>
    </section>
  );
}

function ServersPanel({ nat, s }: { nat: RuntimeNatStun; s: Dict }) {
  const v = s.details.pages.nat.view;
  const state = natMechanismState(nat);
  const enabled = state !== "disabled";
  const delayed = state === "delayed" || state === "missing";
  const configured = nat.servers?.configured ?? [];
  const live = nat.servers?.live ?? [];
  const liveSet = new Set(live);
  const ageV4 = nat.reflection?.v4?.age_secs ?? null;
  const summary = [
    [v.configured, formatNumber(s, configured.length)],
    [v.liveSnapshot, formatNumber(s, live.length)],
    [
      v.refreshAttempt,
      enabled
        ? nat.flags.nat_probe_attempts > 0
          ? formatNumber(s, nat.flags.nat_probe_attempts)
          : v.successfulEarlier
        : v.disabled,
    ],
    [v.cacheIpv4, ageV4 === null ? v.noData : formatAge(ageV4, s)],
  ];

  return (
    <section className="px-4 py-5 sm:px-5" data-testid="nat-servers">
      <SectionHeading
        kicker={v.lastCompletedProbe}
        title={s.details.pages.nat.servers}
        meta={v.configurationAndSnapshot}
      />
      <p
        className={cn(
          "mt-4 flex gap-2 rounded-xl border border-border bg-surface-2 px-4 py-3 text-meta leading-relaxed text-text-muted",
          delayed && "border-warn/40",
        )}
      >
        <span className={delayed ? "text-warn" : "text-accent"}>i</span>
        <span>{v.liveSnapshotNote}</span>
      </p>
      <div className="mt-4 grid overflow-hidden rounded-xl border border-border sm:grid-cols-2 lg:grid-cols-4">
        {summary.map(([label, value]) => (
          <div key={label} className="min-w-0 border-b border-r border-border px-4 py-4">
            <span className="text-micro text-text-muted">{label}</span>
            <strong className="mt-1 block break-all font-mono text-h3 font-bold text-text">
              {value}
            </strong>
          </div>
        ))}
      </div>
      <div className="mt-4 grid overflow-hidden rounded-xl border border-border lg:grid-cols-2">
        {configured.map((server) => {
          const answered = liveSet.has(server);
          const status = !enabled ? v.notQueried : answered ? v.answered : v.absentFromSnapshot;
          return (
            <div
              key={server}
              className={cn(
                "flex min-w-0 items-center justify-between gap-3 border-b border-r border-border px-3 py-3",
                answered && "bg-ok-soft/15",
                delayed && !answered && "bg-warn-soft/10",
              )}
              data-nat-server={answered ? "live" : "absent"}
            >
              <code className="min-w-0 break-all font-mono text-micro text-text">{server}</code>
              <span className="shrink-0 whitespace-nowrap">
                <StatePill state={answered ? "ok" : delayed ? "warn" : "muted"}>{status}</StatePill>
              </span>
            </div>
          );
        })}
        {configured.length === 0 && (
          <p className="px-4 py-10 text-center text-meta text-text-muted">{v.noData}</p>
        )}
      </div>
    </section>
  );
}

function Technical({
  mode,
  gates,
  nat,
  gateEnabled,
  gateReason,
  s,
}: {
  mode: MeRouteMode;
  gates: RuntimeGates;
  nat: RuntimeNatStun | null;
  gateEnabled: boolean | null;
  gateReason?: string;
  s: Dict;
}) {
  const v = s.details.pages.nat.view;
  const rows: Array<[string, string]> = nat
    ? [
        ["flags.nat_probe_enabled", formatRaw(nat.flags.nat_probe_enabled, s)],
        ["flags.nat_probe_disabled_runtime", formatRaw(nat.flags.nat_probe_disabled_runtime, s)],
        ["flags.nat_probe_attempts", formatRaw(nat.flags.nat_probe_attempts, s)],
        ["stun_backoff_remaining_ms", formatRaw(nat.stun_backoff_remaining_ms, s)],
        ["reflection.v4.age_secs", formatRaw(nat.reflection?.v4?.age_secs, s)],
        ["reflection.v6.age_secs", formatRaw(nat.reflection?.v6?.age_secs, s)],
        ["servers.live_total", formatRaw(nat.servers?.live_total, s)],
        ["servers.configured.length", formatNumber(s, nat.servers?.configured?.length ?? 0)],
      ]
    : [
        ["flags.use_middle_proxy", formatRaw(gates.use_middle_proxy, s)],
        ["route_mode", gates.route_mode],
        ["flags.me2dc_fallback_enabled", formatRaw(gates.me2dc_fallback_enabled, s)],
        ["flags.me_runtime_ready", formatRaw(gates.me_runtime_ready, s)],
        ["nat_stun.enabled", formatRaw(gateEnabled, s)],
        ["nat_stun.reason", gateReason ?? "—"],
        ["interpreted_mode", mode],
      ];

  return (
    <details className="group border-t border-border px-4 py-4 sm:px-5" data-testid="nat-technical">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <span>
          <strong className="block text-meta text-text">{v.technical}</strong>
          <span className="block text-micro text-text-muted">{v.technicalDescription}</span>
        </span>
        <IconChevronDown className="shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <dl className="mt-4 grid border-t border-border sm:grid-cols-2 xl:grid-cols-4">
        {rows.map(([label, value]) => (
          <div key={label} className="min-w-0 border-b border-r border-border px-3 py-3">
            <dt className="truncate font-mono text-micro text-text-muted" title={label}>
              {label}
            </dt>
            <dd className="mt-1 break-all text-meta font-semibold tabular-nums text-text">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function NatPage() {
  const runtime = useSnapshot<RuntimeTopic>("runtime");
  const navigate = useNavigate();
  const s = useStrings();
  const nowMs = useNow(1_000);
  const [tab, setTab] = useState<NatTab>("overview");

  const gates = runtime.data?.gates ?? null;
  const mode = gates ? meRouteMode(gates, null) : null;
  const natGate = runtime.data?.nat_stun ?? null;
  const resolved = natGate ? resolveGated(natGate) : null;
  const nat = resolved?.status === "ok" ? resolved.data : null;
  const inputs: Record<string, DetailSourceInput> = {
    nat: { kind: "topic", snapshot: runtime, gated: natGate },
  };
  const sources = useDetailSources(natPageDefinition.sources, inputs);
  const v = s.details.pages.nat.view;
  const headerStatus =
    mode === "direct" ? "ready" : mode === "fallback" ? "partial" : sources.status;
  const tabs: Array<[NatTab, string, number | null]> = [
    ["overview", v.tabs.overview, null],
    ["servers", v.tabs.servers, nat?.servers?.configured?.length ?? null],
  ];

  return (
    <div className="mx-auto w-full max-w-[1160px]" data-testid="nat-detail">
      <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        <div className="border-b border-border px-4 py-4 sm:px-5">
          <DetailHeader
            title={s.details.pages.nat.title}
            description={s.details.pages.nat.description}
            status={headerStatus}
            freshnessMs={sources.freshnessMs}
            nowMs={nowMs}
            onBack={() => void navigate({ to: "/pulse" })}
          />
        </div>

        {!gates || mode === null ? (
          <div className="grid min-h-64 place-items-center px-5 text-center">
            <div>
              <p className="text-h3 font-semibold text-text">{v.loading}</p>
              <p className="mt-1 text-meta text-text-muted">
                {runtime.error ?? v.loadingDescription}
              </p>
            </div>
          </div>
        ) : mode !== "middle" ? (
          <RouteState mode={mode} gates={gates} s={s} />
        ) : nat === null ? (
          <div
            className="grid min-h-64 place-items-center px-5 text-center"
            data-testid="nat-unavailable"
          >
            <div>
              <p className="text-h3 font-semibold text-text">{v.unavailableTitle}</p>
              <p className="mt-1 max-w-lg text-meta text-text-muted">
                {resolved?.status === "gated"
                  ? (resolved.reason ?? v.unavailableDescription)
                  : (runtime.error ?? v.unavailableDescription)}
              </p>
            </div>
          </div>
        ) : (
          <>
            <VerdictHero nat={nat} s={s} />
            <div
              className="border-b border-border px-3 pt-2"
              role="tablist"
              aria-label={s.details.pages.nat.title}
              data-testid="nat-tabs"
            >
              <div className="flex gap-1 overflow-x-auto">
                {tabs.map(([id, label, count]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={tab === id}
                    onClick={() => setTab(id)}
                    className={cn(
                      "shrink-0 rounded-t-lg px-3 py-2.5 text-micro font-semibold",
                      tab === id ? "bg-accent/18 text-accent" : "text-text-muted hover:text-text",
                    )}
                  >
                    {label}
                    {count !== null && (
                      <b className="ml-1 tabular-nums">{formatNumber(s, count)}</b>
                    )}
                  </button>
                ))}
              </div>
            </div>
            <div role="tabpanel">
              {tab === "overview" ? (
                <OverviewPanel nat={nat} s={s} />
              ) : (
                <ServersPanel nat={nat} s={s} />
              )}
            </div>
          </>
        )}

        {gates && mode && (
          <Technical
            mode={mode}
            gates={gates}
            nat={nat}
            gateEnabled={natGate?.enabled ?? null}
            gateReason={natGate?.reason}
            s={s}
          />
        )}
      </section>
    </div>
  );
}
