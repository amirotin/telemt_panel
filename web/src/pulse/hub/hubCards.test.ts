import { describe, expect, it } from "vitest";
import { en, ru } from "../../i18n";
import type { TopicSnapshot } from "../../realtime/types";
import type {
  RuntimeTopic,
  SecurityTopic,
  StatsSnapshot,
  UpstreamsTopic,
  UsersTopic,
} from "../../realtime/topics";
import {
  dcIds,
  degradedWriterCount,
  gatedOff,
  runtimeSnapshot,
  securitySnapshot,
  statsSnapshot,
  upstreamsSnapshot,
  writerCount,
  zeroAll,
  capabilityAbsentRuntimeSnapshot,
  edgeOffRuntimeSnapshot,
  oldBuildRuntimeSnapshot,
  oldBuildStatsSnapshot,
} from "../details-builder/__fixtures__";
import type { QuerySourceInput } from "../details-builder/sources";
import {
  HUB_DOMAINS,
  buildHubCards,
  dcFleetCoverage,
  dcWorstRtt,
  type HubInputs,
} from "./hubCards";

const NOW = 1_756_000_125_000;

function topic<T>(data: T | null, over: Partial<TopicSnapshot<T>> = {}): TopicSnapshot<T> {
  return { data, ts: 1_756_000_000, stale: false, error: null, ...over };
}

function counters(over: Partial<QuerySourceInput> = {}): QuerySourceInput {
  return {
    kind: "query",
    isPending: false,
    isError: false,
    error: null,
    data: zeroAll,
    dataUpdatedAt: NOW,
    ...over,
  };
}

const users: UsersTopic = { users: [], quota: null, quota_supported: true };

function inputs(over: Partial<HubInputs> = {}): HubInputs {
  return {
    stats: topic<StatsSnapshot>(statsSnapshot),
    runtime: topic<RuntimeTopic>(runtimeSnapshot),
    upstreams: topic<UpstreamsTopic>(upstreamsSnapshot),
    security: topic<SecurityTopic>(securitySnapshot),
    users: topic<UsersTopic>(users),
    counters: counters(),
    nowMs: NOW,
    ...over,
  };
}

const DOMAIN_ORDER = [
  "dc",
  "me",
  "security",
  "counters",
  "connections",
  "upstreams",
  "nat",
  "events",
] as const;

describe("the eight hub cards", () => {
  it("covers every diagnostics domain exactly once, in the IA's order", () => {
    expect(HUB_DOMAINS.map((d) => d.domain)).toEqual([...DOMAIN_ORDER]);
    expect(buildHubCards(inputs(), ru).map((c) => c.domain)).toEqual([...DOMAIN_ORDER]);
  });

  it("previews two or three real figures per card on the production fixtures", () => {
    for (const card of buildHubCards(inputs(), ru)) {
      expect(card.status, card.domain).toBe("ready");
      expect(card.pill, card.domain).toBe("ok");
      expect(card.gate, card.domain).toBeNull();
      expect(card.metrics.length, card.domain).toBeGreaterThanOrEqual(2);
      expect(card.metrics.length, card.domain).toBeLessThanOrEqual(3);
      for (const metric of card.metrics) {
        expect(metric.label, `${card.domain}.${metric.id}`).not.toBe("");
        // §13.1's absence placeholder — a preview must not print one where
        // the fixtures carry a real reading.
        expect(metric.text, `${card.domain}.${metric.id}`).not.toBe("—");
      }
    }
  });

  it("names the cards from the shared domain vocabulary in both locales", () => {
    expect(buildHubCards(inputs(), ru).map((c) => c.title)).toEqual(
      DOMAIN_ORDER.map((d) => ru.diag.domains[d]),
    );
    expect(buildHubCards(inputs(), en).map((c) => c.title)).toEqual(
      DOMAIN_ORDER.map((d) => en.diag.domains[d]),
    );
  });

  it("prints the same numbers the Details pages' own summary tiles do", () => {
    const cards = buildHubCards(inputs(), ru);
    const byDomain = Object.fromEntries(cards.map((c) => [c.domain, c]));

    const dc = byDomain["dc"]!;
    expect(dc.metrics.map((m) => m.id)).toEqual(["dc_total", "coverage", "rtt_worst"]);
    expect(dc.metrics[0]!.text).toBe(String(dcIds.length));

    const me = byDomain["me"]!;
    expect(me.metrics.map((m) => m.id)).toEqual(["writers", "degraded", "bound_clients"]);
    expect(me.metrics[0]!.text).toBe(String(writerCount));
    expect(me.metrics[1]!.text).toBe(String(degradedWriterCount));

    const cnt = byDomain["counters"]!;
    expect(cnt.metrics.map((m) => m.id)).toEqual(["total", "non_zero", "errors"]);

    const events = byDomain["events"]!;
    expect(events.metrics.map((m) => m.id)).toEqual(["count", "types", "dropped_total"]);
  });
});

describe("DC fleet aggregates", () => {
  const fleet = upstreamsSnapshot.dcs!.dcs;

  it("weighs coverage by required writers rather than averaging percentages", () => {
    const required = fleet.reduce((n, dc) => n + dc.required_writers, 0);
    const alive = fleet.reduce((n, dc) => n + dc.alive_writers, 0);
    expect(dcFleetCoverage(fleet)).toBeCloseTo((alive / required) * 100, 6);
  });

  it("has no coverage to report when nothing is required", () => {
    expect(dcFleetCoverage([])).toBeNull();
  });

  it("reports the slowest data center, ignoring the ones that never answered", () => {
    const known = fleet.map((dc) => dc.rtt_ms).filter((v): v is number => v !== null);
    expect(dcWorstRtt(fleet)).toBe(Math.max(...known));
    expect(dcWorstRtt(fleet.map((dc) => ({ ...dc, rtt_ms: null })))).toBeNull();
  });
});

describe("gated and unsupported sources (ruling R5)", () => {
  const off: RuntimeTopic = {
    ...runtimeSnapshot,
    nat_stun: gatedOff(),
    recent_events: gatedOff(),
  };

  it("shows the disabled hint instead of a row of dashes", () => {
    const cards = buildHubCards(inputs({ runtime: topic<RuntimeTopic>(off) }), ru);
    for (const domain of ["nat", "events"] as const) {
      const card = cards.find((c) => c.domain === domain)!;
      expect(card.status).toBe("disabled");
      expect(card.pill).toBe("muted");
      expect(card.metrics).toEqual([]);
      expect(card.gate).toEqual({
        variant: "disabled",
        reason: "feature_disabled",
        hint: "runtime_edge",
      });
    }
  });

  it("points an unsupported source at an update, never at a setting", () => {
    const absent: RuntimeTopic = { ...runtimeSnapshot, nat_stun: gatedOff("capability_absent") };
    const card = buildHubCards(inputs({ runtime: topic<RuntimeTopic>(absent) }), ru).find(
      (c) => c.domain === "nat",
    )!;
    expect(card.status).toBe("unsupported");
    expect(card.gate).toEqual({
      variant: "unsupported",
      reason: "capability_absent",
      hint: "telemt_outdated",
    });
  });

  it("applies the same split to the REST-backed Счётчики card", () => {
    const disabled = buildHubCards(
      inputs({ counters: counters({ isError: true, error: { code: "capability_unavailable" } }) }),
      ru,
    ).find((c) => c.domain === "counters")!;
    expect(disabled.status).toBe("disabled");

    const unsupported = buildHubCards(
      inputs({ counters: counters({ isError: true, error: { code: "capability_absent" } }) }),
      ru,
    ).find((c) => c.domain === "counters")!;
    expect(unsupported.status).toBe("unsupported");
    expect(unsupported.gate?.hint).toBe("telemt_outdated");
  });

  it("treats an OMITTED gated field the same as an explicit off wrapper", () => {
    // What a stock build actually sends: hub.go omits `recent_events` and
    // `connections_summary` from the JSON when runtime_edge is off, and
    // leaves `nat_stun` an explicit null. None of the three may end up as a
    // blank card under a green «Актуально» pill.
    const runtimeWithout: RuntimeTopic = { ...runtimeSnapshot };
    delete (runtimeWithout as { recent_events?: unknown }).recent_events;
    runtimeWithout.nat_stun = null;
    const statsWithout: StatsSnapshot = { ...statsSnapshot };
    delete (statsWithout as { connections_summary?: unknown }).connections_summary;

    const cards = buildHubCards(
      inputs({
        runtime: topic<RuntimeTopic>(runtimeWithout),
        stats: topic<StatsSnapshot>(statsWithout),
      }),
      ru,
    );
    for (const domain of ["nat", "events", "connections"] as const) {
      const card = cards.find((c) => c.domain === domain)!;
      expect(card.status, domain).toBe("disabled");
      expect(card.pill, domain).toBe("muted");
      expect(card.metrics, domain).toEqual([]);
      // No wire reason to quote — GatedNote's localized default carries it.
      expect(card.gate, domain).toEqual({ variant: "disabled", hint: "runtime_edge" });
    }
  });

  it("turns middle_proxy_enabled: false into the DC and ME cards' own gate", () => {
    const dcs = upstreamsSnapshot.dcs!;
    const meWriters = upstreamsSnapshot.me_writers!;
    const cards = buildHubCards(
      inputs({
        upstreams: topic<UpstreamsTopic>({
          ...upstreamsSnapshot,
          dcs: { ...dcs, middle_proxy_enabled: false, reason: "middle_proxy_off" },
          me_writers: { ...meWriters, middle_proxy_enabled: false, reason: "middle_proxy_off" },
        }),
      }),
      ru,
    );
    for (const domain of ["dc", "me"] as const) {
      const card = cards.find((c) => c.domain === domain)!;
      expect(card.status).toBe("disabled");
      expect(card.gate).toEqual({ variant: "disabled", reason: "middle_proxy_off" });
    }
  });
});

describe("before anything has arrived", () => {
  it("reports loading with no metrics and no gate — never an empty screen", () => {
    const cards = buildHubCards(
      inputs({
        stats: topic<StatsSnapshot>(null),
        runtime: topic<RuntimeTopic>(null),
        upstreams: topic<UpstreamsTopic>(null),
        security: topic<SecurityTopic>(null),
        users: topic<UsersTopic>(null),
        counters: counters({ isPending: true, data: undefined, dataUpdatedAt: 0 }),
      }),
      ru,
    );
    for (const card of cards) {
      expect(card.status, card.domain).toBe("loading");
      expect(card.metrics, card.domain).toEqual([]);
      expect(card.gate, card.domain).toBeNull();
      expect(card.pillLabel, card.domain).toBe(ru.details.stateShort.loading);
    }
  });

  it("keeps the last payload on screen and flags it when a topic goes stale", () => {
    const card = buildHubCards(
      inputs({ upstreams: topic<UpstreamsTopic>(upstreamsSnapshot, { stale: true }) }),
      ru,
    ).find((c) => c.domain === "dc")!;
    expect(card.status).toBe("stale");
    expect(card.pill).toBe("warn");
    expect(card.metrics.length).toBe(3);
  });
});

// Ruling R5 across Telemt builds, on the hub — the one screen that shows all
// eight domains at once, and therefore the one where a wrong word is
// repeated eight times.
describe("cross-version: the hub on three different builds", () => {
  it("says «switched off» on a 3.4.x build, pointing at a setting", () => {
    // The topic cannot tell "route absent" from "gate closed" — hub.go drops
    // the key either way — so the panel makes the recoverable claim. An
    // operator who looks for the setting and does not find it has lost a
    // minute; one sent to upgrade a proxy they did not need to upgrade has
    // lost an evening.
    const cards = buildHubCards(
      inputs({
        stats: topic<StatsSnapshot>(oldBuildStatsSnapshot),
        runtime: topic<RuntimeTopic>(oldBuildRuntimeSnapshot),
      }),
      ru,
    );
    for (const domain of ["connections", "events"] as const) {
      const card = cards.find((c) => c.domain === domain)!;
      expect(card.status, domain).toBe("disabled");
      expect(card.gate?.variant, domain).toBe("disabled");
      expect(card.gate?.hint, domain).toBe("runtime_edge");
    }
  });

  it("says «not in this version» when the build names the absence itself", () => {
    const cards = buildHubCards(
      inputs({ runtime: topic<RuntimeTopic>(capabilityAbsentRuntimeSnapshot) }),
      ru,
    );
    const nat = cards.find((c) => c.domain === "nat")!;
    expect(nat.status).toBe("unsupported");
    expect(nat.gate).toEqual({
      variant: "unsupported",
      reason: "capability_absent",
      hint: "telemt_outdated",
    });
    // Never both sentences at once, and never the setting hint.
    expect(nat.gate?.hint).not.toBe("runtime_edge");
  });

  it("keeps the two apart on the SAME hub render", () => {
    const cards = buildHubCards(
      inputs({
        runtime: topic<RuntimeTopic>({
          ...edgeOffRuntimeSnapshot,
          me_pool_state: capabilityAbsentRuntimeSnapshot.me_pool_state,
        }),
      }),
      ru,
    );
    expect(cards.find((c) => c.domain === "nat")!.status).toBe("disabled");
    expect(cards.find((c) => c.domain === "events")!.status).toBe("disabled");
  });

  it("never shows the working domains as anything but themselves", () => {
    // §14: a gate on one source must not take the rest of the screen with it.
    const cards = buildHubCards(
      inputs({
        stats: topic<StatsSnapshot>(oldBuildStatsSnapshot),
        runtime: topic<RuntimeTopic>(oldBuildRuntimeSnapshot),
      }),
      ru,
    );
    for (const domain of ["dc", "me", "security", "upstreams"] as const) {
      const card = cards.find((c) => c.domain === domain)!;
      expect(card.status, domain).toBe("ready");
      expect(card.metrics.length, domain).toBeGreaterThan(0);
    }
  });
});
