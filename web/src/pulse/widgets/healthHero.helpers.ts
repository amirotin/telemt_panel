import { healthLabel, healthPillState } from "../../shell/StatusStrip.helpers";
import { formatDurationApprox } from "../../people/expiry";
import { fill, pluralTemplate } from "../../i18n";
import type { State } from "../../ui/StatePill";
import { pickLatestRelease } from "../../server/updates/releases.helpers";
import type { UpdatesStatus } from "../../lib/api/generated/types.gen";
import type { StatsSnapshot } from "../../realtime/topics";
import type { Dict } from "../../i18n";

/** One of the small-caps facts at the banner's right edge. */
export interface HeroFact {
  key: "uptime" | "version" | "configReload";
  label: string;
  value: string;
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

function configReloadValue(stats: StatsSnapshot, s: Dict, now: number): string {
  const at = stats.last_config_reload_epoch_secs;
  if (typeof at === "number" && at > 0) {
    return fill(s.overview.status.ago, { value: formatDurationApprox(now - at * 1000, s) });
  }
  const count = stats.config_reload_count ?? 0;
  if (count > 0) return pluralTemplate(s, count, s.overview.status.reloadTimes);
  return s.overview.status.neverReloaded;
}

// computeHealthHero builds Сводка's status banner (owner decision
// 2026-08-30: no heading, one indicator, facts at the right edge).
//
// The state word reuses StatusStrip's own health-pill/label semantics
// (shell/StatusStrip.helpers.ts) so the always-visible status strip and the
// banner never disagree about what "ok" means — but readiness OVERRIDES it:
// a proxy whose health says "ok" while it refuses every client is not
// «Работает», and that sentence is the whole point of the banner.
//
// read_only is deliberately not a badge here any more. It is a real
// condition, and «Проблемы» already lists it in words; repeating it as a
// chip is exactly the pile-up of indicators this banner replaced.
export function computeHealthHero(
  stats: StatsSnapshot | null,
  s: Dict,
  now: number = Date.now(),
): HealthHeroView | null {
  if (!stats) return null;

  const notReady = stats.ready?.ready === false;
  const uptimeSeconds = stats.uptime_seconds ?? stats.summary?.uptime_seconds ?? null;

  return {
    tone: notReady ? notReadyTone(stats.ready?.reason) : healthPillState(stats.health?.status),
    label: notReady ? s.pulse.health.notAccepting : healthLabel(stats.health?.status, s),
    reason: notReady ? readyReasonText(stats.ready?.reason, s) : undefined,
    facts: [
      {
        key: "uptime",
        label: s.pulse.stat.uptime,
        value: uptimeSeconds === null ? "—" : formatDurationApprox(uptimeSeconds * 1000, s),
      },
      {
        key: "version",
        label: s.overview.status.versionLabel,
        value: stats.version ?? "—",
      },
      {
        key: "configReload",
        label: s.overview.status.configReloadLabel,
        value: configReloadValue(stats, s, now),
      },
    ],
  };
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
