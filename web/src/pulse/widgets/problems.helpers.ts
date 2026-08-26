import { fill, type Dict } from "../../i18n";
import type { DcStatusData, StatsSnapshot } from "../../realtime/topics";

export interface ProblemItem {
  key: string;
  label: string;
  detail?: string;
  /** A short actionable line under the label (e.g. what to check) — kept separate from `detail` because `detail` alone can double as the right-hand count badge (Problems.tsx's `isCount`). */
  hint?: string;
  /** Explicit right-hand badge text, for items whose `detail` is prose that must stay visible alongside a figure (the rate-based counters' "+12" badge over their "+12 за 15 мин · всего 37 086" line). */
  count?: string;
}

export interface StaleTopicInput {
  topic: string;
  stale: boolean;
  error: string | null;
}

// counterDelta turns a pair of readings of one CUMULATIVE counter into the
// growth across the window. `baseline` is undefined when no window exists
// yet (fewer than two snapshots) — the caller must then report nothing at
// all rather than fall back to the lifetime total. A class absent from the
// baseline snapshot legitimately reads as 0 and is the caller's job to pass.
//
// current < baseline means the counter reset (Telemt restarted mid-window),
// so `current` is the whole growth since that reset.
export function counterDelta(baseline: number | undefined, current: number): number | null {
  if (baseline === undefined) return null;
  return current < baseline ? current : current - baseline;
}

// rateItem builds the ProblemItem for one cumulative counter that actually
// moved: the badge carries the delta, the prose line spells the window out
// and keeps the lifetime total visible so the figure is never hidden, only
// demoted. Returns null when the counter did not move (or when there is no
// window yet) — that is the whole point of the rate rules.
function rateItem(
  key: string,
  label: string,
  delta: number | null,
  total: number,
  s: Dict,
): ProblemItem | null {
  if (delta === null || delta <= 0) return null;
  return {
    key,
    label,
    detail: fill(s.pulse.problems.deltaDetail, { delta, total }),
    count: `+${delta}`,
  };
}

// byClassTotal reads one class's cumulative total out of a *_by_class array,
// or 0 when the class is absent — a class Telemt has never seen this run
// simply has no entry, which is a genuine zero, not missing data.
function byClassTotal(list: Array<{ class: string; total: number }> | undefined, cls: string): number {
  return list?.find((e) => e.class === cls)?.total ?? 0;
}

// computeProblems ranks every currently-known problem worst-first: Telemt
// not ready, read-only mode, middle-proxy direct fallback / low coverage /
// split traffic (upstreams topic's `dcs` field — a real Telemt instance can
// have middle_proxy_enabled: true in config yet be silently running direct,
// e.g. when it can't download Telegram's proxy-config at startup, so these
// checks read the live writer counts rather than the config flag alone),
// any topic reporting source_error/stale, then the RATE-based counter rules,
// then missing capabilities (06-ui.md's Проблемы widget:
// "handshake_failures_by_stage из summary, source_error топиков, Telemt not
// ready reason, read_only, capability gaps"). Returns [] when nothing is
// wrong — the widget then shows the "nothing wrong" empty state instead of
// an empty list.
//
// The state-based rules (not-ready, read_only, ME, stale topics, capability
// gaps) describe how the proxy is RIGHT NOW and are reported verbatim. The
// four counter rules — handshake_failures_by_class, connections_bad_total,
// handshake_timeouts_total, connections_bad_by_class — read
// cumulative-since-start scalars instead: on a real 20-day-old VPS they sit
// at 37 086 unexpected_eof / 1 175 bad / 3 585 timeouts purely from internet
// background scanning, and ranking those as problems made a perfectly
// healthy server show three permanent warnings. They are therefore reported
// only when they grew inside the window, diffed against `baseline` — the
// oldest stats snapshot realtime/topicWindow.ts still holds.
//
// `baseline` null (the page just opened, or the summary sub-call failed
// then) means no window: no delta is knowable, so nothing is reported. No
// delta → no alarm, deliberately; the lifetime figures stay available in
// full on the Соединения diagnostics page and, in extended display mode,
// through lifetimeCountersNote below.
export function computeProblems(
  stats: StatsSnapshot | null,
  staleTopics: StaleTopicInput[],
  missingCapabilities: string[],
  dcs: DcStatusData | null,
  s: Dict,
  baseline: StatsSnapshot | null = null,
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
  // summary is a *SummaryData pointer that's null when this poll's sub-call
  // failed — guard the counter rules on BOTH ends being present so neither a
  // transient fetch failure nor a missing baseline reads as a zero delta
  // (null ≠ zero, and "unknown" ≠ "unchanged").
  const summary = stats?.summary;
  const base = baseline?.summary;
  if (summary && base) {
    const failures = [...(summary.handshake_failures_by_class ?? [])].sort(
      (a, b) => b.total - a.total,
    );
    for (const f of failures) {
      const item = rateItem(
        `handshake_${f.class}`,
        `${s.pulse.problems.handshakeFailures}: ${f.class}`,
        counterDelta(byClassTotal(base.handshake_failures_by_class, f.class), f.total),
        f.total,
        s,
      );
      if (item) items.push(item);
    }

    const badTotal = rateItem(
      "connections_bad_total",
      s.pulse.problems.connectionsBad,
      counterDelta(base.connections_bad_total, summary.connections_bad_total),
      summary.connections_bad_total,
      s,
    );
    if (badTotal) items.push(badTotal);

    const timeouts = rateItem(
      "handshake_timeouts_total",
      s.pulse.problems.handshakeTimeouts,
      counterDelta(base.handshake_timeouts_total, summary.handshake_timeouts_total),
      summary.handshake_timeouts_total,
      s,
    );
    if (timeouts) items.push(timeouts);

    const badByClass = [...(summary.connections_bad_by_class ?? [])].sort(
      (a, b) => b.total - a.total,
    );
    for (const c of badByClass) {
      const item = rateItem(
        `connections_bad_${c.class}`,
        `${s.pulse.problems.connectionsBadByClass}: ${c.class}`,
        counterDelta(byClassTotal(base.connections_bad_by_class, c.class), c.total),
        c.total,
        s,
      );
      if (item) items.push(item);
    }
  }
  for (const cap of missingCapabilities) {
    items.push({ key: `cap_${cap}`, label: `${s.pulse.problems.capabilityGap} ${cap}` });
  }

  return items;
}

// lifetimeCountersNote is the one muted informational line the widget shows
// in extended display mode only: computeProblems now stays silent about
// cumulative counters that are not currently growing, and an operator who
// asked for extended detail should still be told the totals exist and where
// the full breakdown lives (the Соединения diagnostics page). Returns null
// when the summary is absent or every counter is genuinely zero — there is
// then nothing to point at.
export function lifetimeCountersNote(stats: StatsSnapshot | null, s: Dict): string | null {
  const summary = stats?.summary;
  if (!summary) return null;
  const handshakeFailures = (summary.handshake_failures_by_class ?? []).reduce(
    (sum, f) => sum + f.total,
    0,
  );
  const parts: string[] = [];
  if (summary.connections_bad_total > 0) {
    parts.push(`${s.pulse.problems.connectionsBad} — ${summary.connections_bad_total}`);
  }
  if (summary.handshake_timeouts_total > 0) {
    parts.push(`${s.pulse.problems.handshakeTimeouts} — ${summary.handshake_timeouts_total}`);
  }
  if (handshakeFailures > 0) {
    parts.push(`${s.pulse.problems.handshakeFailures} — ${handshakeFailures}`);
  }
  if (parts.length === 0) return null;
  return fill(s.pulse.problems.lifetimeCounters, { value: parts.join(" · ") });
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
