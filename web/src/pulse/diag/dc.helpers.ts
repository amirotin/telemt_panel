import { flattenToRows, type KVGroup } from "./rows";
import type { DcStatus, RuntimeMinimalDcPath } from "../../realtime/topics";

// dcGroups gives every configured DC its own group (unlike the DC widget's
// compact table) — full field composition per DC, including per-endpoint
// writer counts, plus that DC's selected network path (minimal.data.
// network_path, mini-task 2c — "minimal" runtime gated, extended mode only)
// merged into the same group under a `network_path.*` prefix when a
// matching entry exists, rather than as a separate top-level group per DC.
export function dcGroups(dcs: DcStatus[], networkPaths: RuntimeMinimalDcPath[] = []): KVGroup[] {
  return dcs.map((dc) => {
    const path = networkPaths.find((p) => p.dc === dc.dc);
    return {
      title: `DC ${dc.dc}`,
      rows: path ? [...flattenToRows(dc), ...flattenToRows(path, "network_path")] : flattenToRows(dc),
    };
  });
}
