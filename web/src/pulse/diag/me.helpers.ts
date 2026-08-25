import type { Dict } from "../../i18n";
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
export function meGroups(input: MeGroupsInput, s: Dict): KVGroup[] {
  const groups: KVGroup[] = [];

  if (input.pool) {
    groups.push({ title: s.diag.groups.generations, rows: flattenToRows(input.pool.generations, s) });
    groups.push({ title: s.diag.groups.hardswap, rows: flattenToRows(input.pool.hardswap, s) });
    groups.push({ title: s.diag.groups.writers, rows: flattenToRows(input.pool.writers, s) });
    groups.push({ title: s.diag.groups.refill, rows: flattenToRows(input.pool.refill, s) });
  }
  if (input.quality) {
    groups.push({ title: s.diag.groups.qualityCounters, rows: flattenToRows(input.quality.counters, s) });
    groups.push({ title: s.diag.groups.routeDrops, rows: flattenToRows(input.quality.route_drops, s) });
    groups.push({ title: s.diag.groups.familyStates, rows: flattenToRows(input.quality.family_states, s) });
    groups.push({ title: s.diag.groups.drainGate, rows: flattenToRows(input.quality.drain_gate, s) });
    groups.push({ title: s.diag.groups.dcRtt, rows: flattenToRows(input.quality.dc_rtt, s) });
  }
  if (input.selftest) {
    groups.push({ title: s.diag.groups.kdf, rows: flattenToRows(input.selftest.kdf, s) });
    groups.push({ title: s.diag.groups.timeskew, rows: flattenToRows(input.selftest.timeskew, s) });
    groups.push({ title: s.diag.groups.ip, rows: flattenToRows(input.selftest.ip, s) });
    groups.push({ title: s.diag.groups.pid, rows: flattenToRows(input.selftest.pid, s) });
    if (input.selftest.bnd) {
      groups.push({ title: s.diag.groups.bnd, rows: flattenToRows(input.selftest.bnd, s) });
    }
    if (input.selftest.upstreams) {
      groups.push({
        title: s.diag.groups.selftestUpstreams,
        rows: flattenToRows(input.selftest.upstreams, s),
      });
    }
  }
  if (input.meWriters) {
    groups.push({ title: s.diag.groups.meWritersSummary, rows: flattenToRows(input.meWriters.summary, s) });
    groups.push({ title: s.diag.groups.meWriters, rows: flattenToRows(input.meWriters.writers, s) });
  }
  if (input.gates) {
    groups.push({ title: s.diag.groups.gates, rows: flattenToRows(input.gates, s) });
  }
  if (input.initialization) {
    groups.push({ title: s.diag.groups.initialization, rows: flattenToRows(input.initialization, s) });
  }
  if (input.meRuntime) {
    groups.push({ title: s.diag.groups.meRuntimeTuning, rows: flattenToRows(input.meRuntime, s) });
  }

  return groups;
}
