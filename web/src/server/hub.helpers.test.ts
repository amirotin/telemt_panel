import { describe, expect, it } from "vitest";
import type { HostInfo, TelemtConfig, UpdatesStatus } from "../lib/api/generated/types.gen";
import {
  activeUpdateRun,
  hostCapabilityCount,
  newestAvailableRelease,
  summarizeServerConfig,
} from "./hub.helpers";

function config(sections: TelemtConfig["sections"]): TelemtConfig {
  return { revision: "rev", sections };
}

describe("summarizeServerConfig", () => {
  it("describes ME with a distinct direct fallback", () => {
    expect(
      summarizeServerConfig(
        config({
          general: {
            use_middle_proxy: true,
            me2dc_fallback: true,
            modes: { tls: true },
          },
          censorship: { mask: true },
          dc_overrides: { "203": ["127.0.0.1:443"] },
        }),
      ),
    ).toEqual({
      routeMode: "me_fallback",
      transport: "tls",
      masking: true,
      dcOverrides: 1,
    });
  });

  it("does not call direct-only mode a fallback", () => {
    expect(
      summarizeServerConfig(
        config({ general: { use_middle_proxy: false, me2dc_fallback: true } }),
      ).routeMode,
    ).toBe("direct");
  });

  it("keeps missing and future section shapes honest", () => {
    expect(summarizeServerConfig(config({ general: null }))).toEqual({
      routeMode: "unknown",
      transport: "unknown",
      masking: null,
      dcOverrides: null,
    });
  });
});

describe("server hub update and host summaries", () => {
  const targets: UpdatesStatus["targets"] = [
    {
      target: "telemt",
      current_version: "3.4.25",
      releases: [
        { version: "3.5.4", published_at: "2026-08-26T00:00:00Z", newer: true },
        { version: "3.5.5", published_at: "2026-08-27T00:00:00Z", newer: true },
      ],
      active_run: {
        run_id: "run-1",
        target: "telemt",
        phase: "installing",
        version_to: "3.5.5",
        started_at: "2026-08-27T00:00:00Z",
      },
    },
  ];

  it("selects the newest newer release and the non-terminal run", () => {
    expect(newestAvailableRelease(targets[0])?.version).toBe("3.5.5");
    expect(activeUpdateRun(targets)?.run_id).toBe("run-1");
  });

  it("counts capabilities without assuming a fixed total", () => {
    const caps: HostInfo["caps"] = {
      restart_telemt: true,
      restart_panel: true,
      log_tail: true,
      log_stream: true,
      self_update: false,
    };
    expect(hostCapabilityCount(caps)).toEqual({ available: 4, total: 5 });
    expect(hostCapabilityCount(undefined)).toEqual({ available: 0, total: 0 });
  });
});
