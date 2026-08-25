import { ru } from "../../i18n/ru";
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
export function upstreamsGroups(data: UpstreamsData, quality?: RuntimeUpstreamQualityData): KVGroup[] {
  const groups: KVGroup[] = [
    ...group(ru.diag.groups.summary, data.summary),
    ...group(ru.diag.groups.zeroCounters, data.zero),
    ...(data.upstreams ?? []).map((u) => ({
      title: `${ru.diag.groups.upstreams} #${u.upstream_id}`,
      rows: flattenToRows(u),
    })),
  ];

  if (quality?.enabled) {
    groups.push({ title: ru.diag.groups.upstreamQualityPolicy, rows: flattenToRows(quality.policy) });
    groups.push({ title: ru.diag.groups.upstreamQualityCounters, rows: flattenToRows(quality.counters) });
    groups.push(...group(ru.diag.groups.upstreamQualitySummary, quality.summary));
    for (const u of quality.upstreams ?? []) {
      groups.push({
        title: `${ru.diag.groups.upstreamQualityUpstream} #${u.upstream_id}`,
        rows: flattenToRows(u),
      });
    }
  }

  return groups;
}
