import type { DcStatusData, RuntimeMinimalDcPath } from "../../realtime/topics";

export interface DcPagePayload extends DcStatusData {
  network_paths?: RuntimeMinimalDcPath[];
}

export function dcEntityKey(dc: Pick<DcStatusData["dcs"][number], "dc">): string {
  return `dc${dc.dc}`;
}

// dcPagePayload joins the two topics the DC Details page reads into the one
// payload its bespoke view expects.
//
// This is all that is left of the old `dcGroups`: composition of the page is
// now the view's job, and this module only says WHERE the data comes
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
