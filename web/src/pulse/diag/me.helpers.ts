import { ru } from "../../i18n/ru";
import { flattenToRows, type KVGroup } from "./rows";
import type {
  MeWritersData,
  RuntimeGates,
  RuntimeInitialization,
  RuntimeMePoolState,
  RuntimeMeQuality,
  RuntimeMeSelftest,
  RuntimeMinimalMeRuntime,
} from "../../realtime/topics";

export interface MeGroupsInput {
  pool?: RuntimeMePoolState;
  quality?: RuntimeMeQuality;
  selftest?: RuntimeMeSelftest;
  meWriters?: MeWritersData;
  gates?: RuntimeGates;
  initialization?: RuntimeInitialization;
  /** minimal.data.me_runtime (mini-task 2c) — undefined both when the "minimal" gate is off and when Telemt omits it (older builds predating this field). */
  meRuntime?: RuntimeMinimalMeRuntime;
}

// meGroups is the ME domain's full-composition builder — combines four
// independently-gated/sourced payloads (pool state, quality, self-test, all
// from the "runtime" topic; writer status from the "upstreams" topic) plus
// the always-on Gates/Initialization groups, since neither has a domain of
// its own among the seven Диагностика pages and both describe ME/startup
// state most directly (06-ui.md only names 7 domains — this is an editorial
// choice documented in task-6-report.md). Each input is independently
// optional: a gated-off or not-yet-loaded sub-payload simply contributes no
// groups, it never blocks the others from rendering.
export function meGroups(input: MeGroupsInput): KVGroup[] {
  const groups: KVGroup[] = [];

  if (input.pool) {
    groups.push({ title: ru.diag.groups.generations, rows: flattenToRows(input.pool.generations) });
    groups.push({ title: ru.diag.groups.hardswap, rows: flattenToRows(input.pool.hardswap) });
    groups.push({ title: ru.diag.groups.writers, rows: flattenToRows(input.pool.writers) });
    groups.push({ title: ru.diag.groups.refill, rows: flattenToRows(input.pool.refill) });
  }
  if (input.quality) {
    groups.push({ title: ru.diag.groups.qualityCounters, rows: flattenToRows(input.quality.counters) });
    groups.push({ title: ru.diag.groups.routeDrops, rows: flattenToRows(input.quality.route_drops) });
    groups.push({ title: ru.diag.groups.familyStates, rows: flattenToRows(input.quality.family_states) });
    groups.push({ title: ru.diag.groups.drainGate, rows: flattenToRows(input.quality.drain_gate) });
    groups.push({ title: ru.diag.groups.dcRtt, rows: flattenToRows(input.quality.dc_rtt) });
  }
  if (input.selftest) {
    groups.push({ title: ru.diag.groups.kdf, rows: flattenToRows(input.selftest.kdf) });
    groups.push({ title: ru.diag.groups.timeskew, rows: flattenToRows(input.selftest.timeskew) });
    groups.push({ title: ru.diag.groups.ip, rows: flattenToRows(input.selftest.ip) });
    groups.push({ title: ru.diag.groups.pid, rows: flattenToRows(input.selftest.pid) });
    if (input.selftest.bnd) {
      groups.push({ title: ru.diag.groups.bnd, rows: flattenToRows(input.selftest.bnd) });
    }
    if (input.selftest.upstreams) {
      groups.push({
        title: ru.diag.groups.selftestUpstreams,
        rows: flattenToRows(input.selftest.upstreams),
      });
    }
  }
  if (input.meWriters) {
    groups.push({ title: ru.diag.groups.meWritersSummary, rows: flattenToRows(input.meWriters.summary) });
    groups.push({ title: ru.diag.groups.meWriters, rows: flattenToRows(input.meWriters.writers) });
  }
  if (input.gates) {
    groups.push({ title: ru.diag.groups.gates, rows: flattenToRows(input.gates) });
  }
  if (input.initialization) {
    groups.push({ title: ru.diag.groups.initialization, rows: flattenToRows(input.initialization) });
  }
  if (input.meRuntime) {
    groups.push({ title: ru.diag.groups.meRuntimeTuning, rows: flattenToRows(input.meRuntime) });
  }

  return groups;
}
