import { expect, it } from "vitest";
import type { TelemtConfigState } from "../../lib/api/generated/types.gen";
import { nativeStateMatches } from "./configNativeState";
const current: TelemtConfigState = { revision: "r2", desired_revision: "r2", desired_status: "valid", runtime: { active_generation: 3, config_epoch: 4, runtime_match: "g3e4" }, runtime_sample_current: true, sections: ["general", "network", "server", "timeouts", "censorship", "upstreams", "dc_overrides", "web", "access", "logging", "root"], comparison: { status: "published_match", truncated: false, pending_paths: [], watcher_pending_paths: [], generation_pending_paths: [], process_deferred_paths: [] } };
it("confirms a full current matching publication", () => { expect(nativeStateMatches(current, "r2")).toBe(true); });
it.each([
  { comparison: { status: "published_match", truncated: false } }, { comparison: { ...current.comparison, generation_pending_paths: ["access.user_source_deny"] } }, { runtime_sample_current: false }, { runtime_sample_current: undefined }, { desired_status: "invalid" }, { desired_revision: null }, { revision: null }, { sections: ["general"] }, { sections: undefined }, { comparison: { status: "published_match", truncated: true } }, { comparison: { status: "published_match" } }, { comparison: { status: "unknown", truncated: false } }, { projection_error: { path: "$", code: "redacted", message: "redacted" } },
])("does not confirm application from partial or unavailable state: %o", (patch) => { expect(nativeStateMatches({ ...current, ...patch })).toBe(false); });
it("never settles a newer save with an earlier source revision", () => { expect(nativeStateMatches(current, "r3")).toBe(false); });
