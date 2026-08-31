import { healthLabel, healthPillState } from "../../shell/StatusStrip.helpers";
import { formatDurationApprox } from "../../people/expiry";
import type { State } from "../../ui/StatePill";
import { pickLatestRelease } from "../../server/updates/releases.helpers";
import type { UpdatesStatus } from "../../lib/api/generated/types.gen";
import type { RuntimeGates, RuntimeTopic, StatsSnapshot } from "../../realtime/topics";
import type { Dict } from "../../i18n";

/** One of the small-caps facts at the banner's right edge. */
export interface HeroFact {
  key: "uptime" | "version" | "route";
  label: string;
  value: string;
}

export interface HealthHeroInput {
  stats: StatsSnapshot | null;
  runtime: RuntimeTopic | null;
  /** The stats topic is reporting source_error — Telemt itself is unreachable. */
  unreachable: boolean;
  /** A supporting subsystem is impaired while Telemt itself is still serving. */
  degraded?: boolean;
}

export interface HealthHeroView {
  /** Drives the banner's whole appearance: its gradient wash, its hairline and the colour of the state word. */
  tone: State;
  /** The ONE indicator (owner decision 2026-08-30): a single word for the state, nothing beside it. */
  label: string;
  /** Only when the proxy is not accepting clients — Telemt's reason token, in words. */
  reason?: string;
  facts: HeroFact[];
}

// Telemt's `/v1/health/ready` reason vocabulary (src/api/mod.rs @3.5.5):
// `ready` is `admission_open && healthy_upstreams > 0`, and the reason is
// exactly one of these two tokens. Anything else a future build starts
// sending falls through to the raw token — an untranslated word the
// operator can search for beats «Причина не указана» hiding it.
//
// The lookup normalizes separators first: the same two reasons appear as
// "admission closed" / "no healthy upstreams" in the API notes, and a
// build that spells them with spaces must map to the same sentence.
const READY_REASONS: Record<string, (s: Dict) => string> = {
  admission_closed: (s) => s.pulse.health.readyReason.admissionClosed,
  no_healthy_upstreams: (s) => s.pulse.health.readyReason.noHealthyUpstreams,
};

export function readyReasonText(reason: string | undefined, s: Dict): string {
  if (!reason) return s.pulse.health.noReason;
  const token = reason.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return READY_REASONS[token]?.(s) ?? reason;
}

// «Приём закрыт» is an operator draining the proxy on purpose — a warning,
// not a failure. Every other way to be not-ready (no upstream is answering)
// is one.
function notReadyTone(reason: string | undefined): State {
  const token = reason?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return token === "admission_closed" ? "warn" : "error";
}

// routeModeValue — which way traffic is actually going right now, from the
// runtime gates (Telemt's own `route_mode` is "middle" | "direct", and
// `reroute_active` is set when middle-proxy IS configured but the relay has
// fallen back to direct). Real operational state, unlike a config flag: an
// instance with middle_proxy_enabled: true can be running direct because it
// never managed to fetch Telegram's proxy config.
export function routeModeValue(gates: RuntimeGates | null, s: Dict): string {
  if (!gates) return "—";
  if (!gates.use_middle_proxy) return s.overview.status.routeDirect;
  if (gates.reroute_active || gates.route_mode === "direct") {
    return s.overview.status.routeFallback;
  }
  return s.overview.status.routeMe;
}

// isStarting — Telemt is up and answering but has not finished coming up.
// gates.startup_status is "initializing" | "ready" (src/startup.rs); the
// initialization group's own status is the fallback for a build or a
// capability set where the gates call did not come back.
function isStarting(runtime: RuntimeTopic | null): boolean {
  const startup = runtime?.gates?.startup_status;
  if (startup) return startup !== "ready";
  const init = runtime?.initialization?.status;
  return init !== undefined && init !== "ready";
}

// computeHealthHero builds Сводка's status banner (owner decisions
// 2026-08-30 and the dashboard concept §4): no heading, ONE aggregated
// state, and facts on the right that no other card repeats.
//
// The operational states, worst first — Нет связи (Telemt is not answering
// at all), Запускается (up, still initializing), Деградация (up, refusing
// clients or with an impaired supporting subsystem), Работает. Readiness OVERRIDES
// health: a proxy whose /v1/health says "ok" while it turns every client
// away is not «Работает», and that sentence is the whole point of the
// banner.
//
// read_only is deliberately not a badge here any more. It is a real
// condition, and «Проблемы» already lists it in words; repeating it as a
// chip is exactly the pile-up of indicators this banner replaced.
export function computeHealthHero(input: HealthHeroInput, s: Dict): HealthHeroView | null {
  const { stats, runtime, unreachable, degraded = false } = input;
  if (!stats && !unreachable) return null;

  const uptimeSeconds = stats?.uptime_seconds ?? stats?.summary?.uptime_seconds ?? null;
  const facts: HeroFact[] = [
    {
      key: "uptime",
      label: s.pulse.stat.uptime,
      value: uptimeSeconds === null ? "—" : formatDurationApprox(uptimeSeconds * 1000, s),
    },
    { key: "version", label: s.overview.status.versionLabel, value: stats?.version ?? "—" },
    {
      key: "route",
      label: s.overview.status.routeLabel,
      value: routeModeValue(runtime?.gates ?? null, s),
    },
  ];

  const state = ((): Pick<HealthHeroView, "tone" | "label" | "reason"> => {
    if (unreachable) {
      return { tone: "error", label: s.pulse.health.unavailable };
    }
    if (isStarting(runtime)) {
      return { tone: "warn", label: s.health.starting };
    }
    if (stats?.ready?.ready === false) {
      return {
        tone: notReadyTone(stats.ready.reason),
        label: s.pulse.health.limited,
        reason: readyReasonText(stats.ready.reason, s),
      };
    }
    const health = stats?.health?.status;
    if (health && healthPillState(health) !== "ok") {
      return { tone: "warn", label: s.pulse.health.limited, reason: healthLabel(health, s) };
    }
    if (degraded) {
      return { tone: "warn", label: s.health.degraded };
    }
    if (!health) return { tone: "muted", label: s.health.unknown };
    return { tone: "ok", label: s.health.ok };
  })();

  return { ...state, facts };
}

// telemtUpdateVersion — the version behind the banner's «Доступна X» chip.
// Only the Telemt target: the banner's own facts name the running Telemt
// version, so a chip beside them can only mean that one. A panel update is
// the Обновления page's business, and the chip links there anyway.
export function telemtUpdateVersion(updates: UpdatesStatus | undefined): string | null {
  const target = updates?.targets.find((t) => t.target === "telemt");
  if (!target) return null;
  return pickLatestRelease(target.releases)?.version ?? null;
}
