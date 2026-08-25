import type { Dict } from "../../i18n";
import { flattenToRows, type KVGroup } from "./rows";
import type { RuntimeNatStun } from "../../realtime/topics";

export function natGroups(data: RuntimeNatStun, s: Dict): KVGroup[] {
  return [
    { title: s.diag.groups.flags, rows: flattenToRows(data.flags, s) },
    { title: s.diag.groups.servers, rows: flattenToRows(data.servers, s) },
    { title: s.diag.groups.reflection, rows: flattenToRows(data.reflection, s) },
  ];
}
