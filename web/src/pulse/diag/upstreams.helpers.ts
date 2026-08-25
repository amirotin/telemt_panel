import type { Dict } from "../../i18n";
import { flattenToRows, group, type KVGroup } from "./rows";
import type { RuntimeUpstreamQualityData, UpstreamsData } from "../../realtime/topics";

// upstreamsGroups: the summary rollup, the connect-counter block (always
// present regardless of gate state), one group per configured upstream —
// full field composition per upstream, not just the widget's
// route/address/health columns — then, when `quality` is enabled (mini-task
// 2c's runtime.upstream_quality, gated behind minimal_runtime_enabled, same
// as `data` itself), its policy/counters and one group per upstream's own
// quality row (latency-by-DC breakdown, distinct from stats/upstreams'
// per-upstream rows above).
export function upstreamsGroups(
  data: UpstreamsData,
  s: Dict,
  quality?: RuntimeUpstreamQualityData,
): KVGroup[] {
  const groups: KVGroup[] = [
    ...group(s.diag.groups.summary, data.summary, s),
    ...group(s.diag.groups.zeroCounters, data.zero, s),
    ...(data.upstreams ?? []).map((u) => ({
      title: `${s.diag.groups.upstreams} #${u.upstream_id}`,
      rows: flattenToRows(u, s),
    })),
  ];

  if (quality?.enabled) {
    groups.push({ title: s.diag.groups.upstreamQualityPolicy, rows: flattenToRows(quality.policy, s) });
    groups.push({ title: s.diag.groups.upstreamQualityCounters, rows: flattenToRows(quality.counters, s) });
    groups.push(...group(s.diag.groups.upstreamQualitySummary, quality.summary, s));
    for (const u of quality.upstreams ?? []) {
      groups.push({
        title: `${s.diag.groups.upstreamQualityUpstream} #${u.upstream_id}`,
        rows: flattenToRows(u, s),
      });
    }
  }

  return groups;
}
