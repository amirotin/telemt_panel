import { describe, expect, it } from "vitest";
import {
  connectionsSources,
  countersSources,
  dcSources,
  eventsSources,
  meSources,
  natSources,
  securitySources,
  upstreamsSources,
  webSources,
} from "./sourceDefinitions";

describe("diagnostic source definitions", () => {
  it("preserves every required, optional, freshness and capability boundary", () => {
    expect(connectionsSources).toEqual([
      { id: "stats", topic: "stats", required: true },
      { id: "connections", topic: "stats", required: false },
    ]);
    expect(countersSources).toEqual([
      { id: "zero", endpoint: "/api/telemt/zero", required: true },
    ]);
    expect(dcSources).toEqual([
      {
        id: "upstreams",
        topic: "upstreams",
        required: true,
        freshnessPath: "generated_at_epoch_secs",
      },
      { id: "runtime", topic: "runtime", required: false },
    ]);
    expect(eventsSources).toEqual([
      { id: "events", topic: "runtime", required: true },
    ]);
    expect(meSources).toEqual([
      {
        id: "upstreams",
        topic: "upstreams",
        required: true,
        freshnessPath: "generated_at_epoch_secs",
      },
      { id: "runtime", topic: "runtime", required: false },
      { id: "runtime_edge", topic: "runtime", required: false },
      { id: "minimal", topic: "runtime", required: false },
    ]);
    expect(natSources).toEqual([
      { id: "nat", topic: "runtime", required: true },
    ]);
    expect(securitySources).toEqual([
      { id: "security", topic: "security", required: true },
      { id: "tls", endpoint: "/api/telemt/tls-fingerprints", required: false },
    ]);
    expect(upstreamsSources).toEqual([
      {
        id: "upstreams",
        topic: "upstreams",
        required: true,
        freshnessPath: "stats.generated_at_epoch_secs",
      },
      { id: "quality", topic: "runtime", required: false },
    ]);
    expect(webSources).toEqual([
      { id: "status", topic: "web", required: true, capabilityPath: "status" },
      { id: "sessions", endpoint: "/api/telemt/web/sessions", required: false },
    ]);
  });
});
