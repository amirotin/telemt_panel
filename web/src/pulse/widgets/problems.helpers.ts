import { fill, type Dict } from "../../i18n";
import type { DcStatusData, StatsSnapshot } from "../../realtime/topics";

export interface ProblemItem {
  key: string;
  label: string;
  detail?: string;
  /** A short actionable line under the label (e.g. what to check) — kept separate from `detail` because `detail` alone can double as the right-hand count badge (Problems.tsx's `isCount`). */
  hint?: string;
}

export interface StaleTopicInput {
  topic: string;
  stale: boolean;
  error: string | null;
}

// computeProblems ranks every currently-known problem worst-first: Telemt
// not ready, read-only mode, middle-proxy direct fallback / low coverage /
// split traffic (upstreams topic's `dcs` field — a real Telemt instance can
// have middle_proxy_enabled: true in config yet be silently running direct,
// e.g. when it can't download Telegram's proxy-config at startup, so these
// checks read the live writer counts rather than the config flag alone),
// any topic reporting source_error/stale, ranked handshake failures by
// class (descending, zero-count classes dropped), the aggregate
// connections_bad_total/handshake_timeouts_total scalars (only when
// non-zero — stats.summary being entirely absent this poll must never be
// read as "zero problems", so these are only pushed when `stats.summary`
// itself is present), ranked connections_bad_by_class, then missing
// capabilities (06-ui.md's Проблемы widget: "handshake_failures_by_stage из
// summary, source_error топиков, Telemt not ready reason, read_only,
// capability gaps"). Returns [] when nothing is wrong — the widget then
// shows the "nothing wrong" empty state instead of an empty list.
export function computeProblems(
  stats: StatsSnapshot | null,
  staleTopics: StaleTopicInput[],
  missingCapabilities: string[],
  dcs: DcStatusData | null,
  s: Dict,
): ProblemItem[] {
  const items: ProblemItem[] = [];

  if (stats?.ready && !stats.ready.ready) {
    items.push({ key: "not_ready", label: s.pulse.problems.notReady, detail: stats.ready.reason });
  }
  if (stats?.health?.read_only) {
    items.push({ key: "read_only", label: s.pulse.problems.readOnly });
  }

  // dcList is [] both when the dcs topic hasn't loaded yet and when
  // middle_proxy_enabled is false (deliberately direct) — either way, none
  // of the three checks below should fire.
  const dcList = dcs?.middle_proxy_enabled ? dcs.dcs : [];
  const fullFallback = dcList.length > 0 && dcList.every((d) => d.alive_writers === 0);
  if (fullFallback) {
    items.push({
      key: "me_direct_fallback",
      label: s.pulse.problems.meDirectFallback,
      detail: String(dcList.length),
      hint: s.pulse.problems.meDirectFallbackHint,
    });
  }
  // Per-DC coverage gaps are only surfaced when it's not a total fallback
  // (already reported above as the more severe, single error) — otherwise
  // every DC would double-report the same "0 writers" fact as both an
  // error and N separate warnings.
  if (dcList.length > 0 && !fullFallback) {
    const low = dcList.filter(
      (d) => d.alive_writers < d.floor_min || (d.required_writers > 0 && d.coverage_pct < 100),
    );
    for (const d of [...low].sort((a, b) => a.coverage_pct - b.coverage_pct)) {
      items.push({
        key: `me_coverage_low_${d.dc}`,
        label: `${s.pulse.problems.meCoverageLow}: DC ${d.dc}`,
        detail: fill(s.pulse.problems.meCoverageLowDetail, {
          alive: d.alive_writers,
          floor: d.floor_min,
          pct: d.coverage_pct,
        }),
      });
    }
  }
  const edgeTotals = stats?.connections_summary?.data?.totals;
  if (
    dcs?.middle_proxy_enabled &&
    edgeTotals &&
    edgeTotals.current_connections_direct > 0 &&
    edgeTotals.current_connections_me === 0
  ) {
    items.push({
      key: "me_split_traffic",
      label: s.pulse.problems.meSplitTraffic,
      detail: String(edgeTotals.current_connections_direct),
    });
  }

  for (const t of staleTopics) {
    if (t.stale || t.error) {
      items.push({
        key: `stale_${t.topic}`,
        label: `${s.pulse.problems.staleTopic} ${t.topic}`,
        detail: t.error ?? undefined,
      });
    }
  }
  const failures = stats?.summary?.handshake_failures_by_class ?? [];
  for (const f of [...failures].sort((a, b) => b.total - a.total)) {
    if (f.total > 0) {
      items.push({
        key: `handshake_${f.class}`,
        label: `${s.pulse.problems.handshakeFailures}: ${f.class}`,
        detail: String(f.total),
      });
    }
  }
  // summary is a *SummaryData pointer that's null when this poll's sub-call
  // failed — guard the whole block on its presence so a transient fetch
  // failure never reads as "zero bad connections" (null ≠ zero).
  if (stats?.summary) {
    if (stats.summary.connections_bad_total > 0) {
      items.push({
        key: "connections_bad_total",
        label: s.pulse.problems.connectionsBad,
        detail: String(stats.summary.connections_bad_total),
      });
    }
    if (stats.summary.handshake_timeouts_total > 0) {
      items.push({
        key: "handshake_timeouts_total",
        label: s.pulse.problems.handshakeTimeouts,
        detail: String(stats.summary.handshake_timeouts_total),
      });
    }
  }
  const badByClass = stats?.summary?.connections_bad_by_class ?? [];
  for (const c of [...badByClass].sort((a, b) => b.total - a.total)) {
    if (c.total > 0) {
      items.push({
        key: `connections_bad_${c.class}`,
        label: `${s.pulse.problems.connectionsBadByClass}: ${c.class}`,
        detail: String(c.total),
      });
    }
  }
  for (const cap of missingCapabilities) {
    items.push({ key: `cap_${cap}`, label: `${s.pulse.problems.capabilityGap} ${cap}` });
  }

  return items;
}

// problemSeverity maps a ProblemItem's stable `key` onto the app's one
// status vocabulary (ok|warn|error|muted) so the widget can show the same
// severity pills the rest of the UI uses. It reads the key rather than
// adding a field to ProblemItem, because the key is already the item's
// identity and computeProblems' callers (and its tests) treat ProblemItem
// as a fixed shape.
export function problemSeverity(key: string): "error" | "warn" | "muted" {
  if (key === "not_ready" || key === "me_direct_fallback") return "error";
  if (key.startsWith("cap_")) return "muted";
  return "warn";
}
