import type { DcStatusData, RuntimeMinimalDcPath } from "../../realtime/topics";
import type { DcPagePayload } from "../details-builder/definitions/dc";

// dcPagePayload joins the two topics the DC Details page reads into the one
// payload its definition expects (details-builder/definitions/dc.ts).
//
// This is all that is left of the old `dcGroups`: composition of the page is
// now the definition's job, and this module only says WHERE the data comes
// from. `network_path` (mini-task 2c) lives behind its own gate
// (minimal_runtime_enabled) and simply does not arrive when that gate is
// off — the page reports it as a degraded optional source and every other
// section keeps working, rather than the whole page failing (spec §14).
export function dcPagePayload(
  dcs: DcStatusData | null | undefined,
  networkPaths: RuntimeMinimalDcPath[] = [],
): DcPagePayload | null {
  if (!dcs) return null;
  return networkPaths.length === 0 ? dcs : { ...dcs, network_paths: networkPaths };
}
