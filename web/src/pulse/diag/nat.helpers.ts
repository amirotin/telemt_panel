import { ru } from "../../i18n/ru";
import { flattenToRows, type KVGroup } from "./rows";
import type { RuntimeNatStun } from "../../realtime/topics";

export function natGroups(data: RuntimeNatStun): KVGroup[] {
  return [
    { title: ru.diag.groups.flags, rows: flattenToRows(data.flags) },
    { title: ru.diag.groups.servers, rows: flattenToRows(data.servers) },
    { title: ru.diag.groups.reflection, rows: flattenToRows(data.reflection) },
  ];
}
