import type { Dict } from "../../i18n";
import { flattenToRows, type KVGroup } from "./rows";
import type { ZeroAllData } from "../../lib/api/generated/types.gen";

// countersGroups builds the five named sections GET /v1/stats/zero/all
// carries (core/upstream/middle_proxy/pool/desync — 07-telemt-sdk.md), each
// section's leaves flattened generically since they are Telemt's own
// internal counter names (ZeroSection is display-only, see
// internal/telemt/types_stats.go's doc comment) — this is the deep-dump
// backbone the Счётчики page's search filter (rows.ts's filterGroups)
// operates over.
export function countersGroups(data: ZeroAllData, s: Dict): KVGroup[] {
  return [
    { title: s.diag.groups.core, rows: flattenToRows(data.core, s) },
    { title: s.diag.groups.upstream, rows: flattenToRows(data.upstream, s) },
    { title: s.diag.groups.middleProxy, rows: flattenToRows(data.middle_proxy, s) },
    { title: s.diag.groups.pool, rows: flattenToRows(data.pool, s) },
    { title: s.diag.groups.desync, rows: flattenToRows(data.desync, s) },
  ];
}
