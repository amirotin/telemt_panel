import type { RuntimeUpstreamQualityData, UpstreamStatus, UpstreamsData } from "../../realtime/topics";
import type { UpstreamsPagePayload } from "../details-builder/definitions/upstreams";

// upstreamsPagePayload joins the two endpoints the Upstreams domain is
// spread across into the ONE payload its definition reads
// (details-builder/definitions/upstreams.ts).
//
// This is all that is left of the old `upstreamsGroups`, which rendered the
// same upstream twice — «Апстримы #0» from `GET /v1/stats/upstreams` and
// «Качество апстрима #0» from `GET /v1/runtime/upstream-quality`, both with
// the nested `dc[]` flattened into rows. TELEMT_LIVE_API_DATA §7 records why
// that is wrong: `upstreams[]` «повторяет сущность upstream и её `dc[]`»,
// so the two are one entity seen from two endpoints.
//
// THE MERGE RULE, applied to all three blocks the two halves duplicate:
// the stats copy wins where it has a value, quality fills what stats does
// not carry, and an id only quality knows about is appended. Nothing is
// averaged and nothing is invented — both numbers come from the same proxy,
// and preferring one endpoint consistently is what stops the page from
// showing two slightly different answers to the same question.
function mergeUpstream(stats: UpstreamStatus, quality: UpstreamStatus): UpstreamStatus {
  return {
    ...quality,
    ...Object.fromEntries(Object.entries(stats).filter(([, value]) => value !== undefined && value !== null)),
  } as UpstreamStatus;
}

export function mergeUpstreams(
  stats: readonly UpstreamStatus[] | undefined,
  quality: readonly UpstreamStatus[] | undefined,
): UpstreamStatus[] {
  const byId = new Map<number, UpstreamStatus>();
  for (const upstream of quality ?? []) byId.set(upstream.upstream_id, upstream);
  const merged: UpstreamStatus[] = [];
  for (const upstream of stats ?? []) {
    const other = byId.get(upstream.upstream_id);
    merged.push(other === undefined ? upstream : mergeUpstream(upstream, other));
    byId.delete(upstream.upstream_id);
  }
  // Quality-only ids keep Telemt's own order rather than being sorted into
  // the stats list: a route stats has not reported yet is new, and showing
  // it last is honest about that.
  return [...merged, ...byId.values()];
}

export function upstreamsPagePayload(
  stats: UpstreamsData | null | undefined,
  quality: RuntimeUpstreamQualityData | null | undefined,
): UpstreamsPagePayload | null {
  if (!stats && !quality) return null;
  const upstreams = mergeUpstreams(stats?.upstreams, quality?.upstreams);
  const summary = stats?.summary ?? quality?.summary;
  // The four connect counters live on both endpoints under different names
  // (`zero` vs `counters`) and mean the same thing. The page shows them
  // once; quality's copy is the fallback for a build where the stats half
  // is unavailable.
  const zero = stats?.zero ?? quality?.counters;
  return {
    ...(upstreams.length > 0 ? { upstreams } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(zero !== undefined ? { zero } : {}),
    ...(stats
      ? {
          stats: {
            enabled: stats.enabled,
            ...(stats.reason !== undefined ? { reason: stats.reason } : {}),
            generated_at_epoch_secs: stats.generated_at_epoch_secs,
          },
        }
      : {}),
    ...(quality
      ? {
          upstream_quality: {
            enabled: quality.enabled,
            ...(quality.reason !== undefined ? { reason: quality.reason } : {}),
            generated_at_epoch_secs: quality.generated_at_epoch_secs,
            policy: quality.policy,
          },
        }
      : {}),
  };
}
