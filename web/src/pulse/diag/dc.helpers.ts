import { flattenToRows, type KVGroup } from "./rows";
import type { DcStatus } from "../../realtime/topics";

// dcGroups gives every configured DC its own group (unlike the DC widget's
// compact table) — full field composition per DC, including per-endpoint
// writer counts. `dcs` is a nil Go slice (JSON `null`, not `[]`) when no DCs
// are configured at all — confirmed against the live mock server.
export function dcGroups(dcs: DcStatus[] | null): KVGroup[] {
  return (dcs ?? []).map((dc) => ({ title: `DC ${dc.dc}`, rows: flattenToRows(dc) }));
}
