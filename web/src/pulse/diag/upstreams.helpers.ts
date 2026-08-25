import { ru } from "../../i18n/ru";
import { flattenToRows, group, type KVGroup } from "./rows";
import type { UpstreamsData } from "../../realtime/topics";

// upstreamsGroups: the summary rollup, the connect-counter block (always
// present regardless of gate state), then one group per configured
// upstream — full field composition per upstream, not just the widget's
// route/address/health columns.
export function upstreamsGroups(data: UpstreamsData): KVGroup[] {
  return [
    ...group(ru.diag.groups.summary, data.summary),
    ...group(ru.diag.groups.zeroCounters, data.zero),
    ...(data.upstreams ?? []).map((u) => ({
      title: `${ru.diag.groups.upstreams} #${u.upstream_id}`,
      rows: flattenToRows(u),
    })),
  ];
}
