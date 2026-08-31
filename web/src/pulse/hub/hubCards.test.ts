import { describe, expect, it } from "vitest";
import { en, ru } from "../../i18n";
import type { HistorySeries } from "../../lib/api/generated/types.gen";
import type { TopicSnapshot } from "../../realtime/types";
import type {
  RuntimeTopic,
  SecurityTopic,
  StatsSnapshot,
  UpstreamsTopic,
  UsersTopic,
  WebTopic,
} from "../../realtime/topics";
import {
  dcIds,
  degradedWriterCount,
  gatedOff,
  natStunLive0,
  natStunLive10,
  runtimeSnapshot,
  securitySnapshot,
  statsSnapshot,
  upstreamsSnapshot,
  zeroAll,
  capabilityAbsentRuntimeSnapshot,
  edgeOffRuntimeSnapshot,
  oldBuildRuntimeSnapshot,
  oldBuildStatsSnapshot,
  webTopicRunning,
  webTopicDisabled,
  webTopicUnsupported,
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

function history(metric: string, first: number, last: number): HistorySeries {
  return {
    metric,
    range: "30m",
    retention_secs: 1800,
    points: [
      { ts: Math.floor(NOW / 1000) - 15 * 60, v: first },
      { ts: Math.floor(NOW / 1000), v: last },
    ],
  };
}

function inputs(over: Partial<HubInputs> = {}): HubInputs {
  return {
    stats: topic<StatsSnapshot>(statsSnapshot),
    runtime: topic<RuntimeTopic>(runtimeSnapshot),
    upstreams: topic<UpstreamsTopic>(upstreamsSnapshot),
    security: topic<SecurityTopic>(securitySnapshot),
    users: topic<UsersTopic>(users),
    web: topic<WebTopic>(webTopicRunning),
    counters: counters(),
    history: {
      attempts: history("attempts", 10_000, 11_000),
      refusals: history("refusals", 100, 110),
    },
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
  "web",
] as const;

describe("the nine hub cards", () => {
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

  it("previews the operational figures selected for each domain", () => {
    const cards = buildHubCards(inputs(), ru);
    const byDomain = Object.fromEntries(cards.map((c) => [c.domain, c]));

    const dc = byDomain["dc"]!;
    expect(dc.metrics.map((m) => m.id)).toEqual(["dc_total", "coverage", "rtt_worst"]);
    expect(dc.metrics[0]!.text).toBe(String(dcIds.length));

    const connections = byDomain["connections"]!;
    expect(connections.metrics.map((m) => m.id)).toEqual([
      "current_connections",
      "active_users",
      "admission",
    ]);

    const me = byDomain["me"]!;
    expect(me.metrics.map((m) => m.id)).toEqual(["healthy_writers", "degraded", "bound_clients"]);
    expect(me.metrics[1]!.text).toBe(String(degradedWriterCount));

    const cnt = byDomain["counters"]!;
    expect(cnt.metrics.map((m) => m.id)).toEqual(["quality", "refusals_15m", "attempts_15m"]);
    expect(cnt.metrics.map((m) => m.text)).toEqual(["99 %", "10", "1 000"]);

    const nat = byDomain["nat"]!;
    expect(nat.metrics.map((m) => m.id)).toEqual([
      "reflection_age",
      "reflection_families",
      "probe_attempts",
    ]);

    const events = byDomain["events"]!;
    expect(events.metrics.map((m) => m.id)).toEqual(["last_event", "event_type", "events_24h"]);

    const security = byDomain["security"]!;
    expect(security.metrics.map((m) => m.id)).toEqual([
      "whitelist_state",
      "whitelist_size",
      "api_mode",
    ]);
  });

  it("separates source freshness, current health, and accumulated evidence", () => {
    const cards = buildHubCards(inputs(), ru);
    const byDomain = Object.fromEntries(cards.map((card) => [card.domain, card]));

    expect(byDomain["me"]!.health).toBe("warn");
    expect(byDomain["me"]!.healthLabel).toBe(ru.hub.states.warn);
    // A fresh reflection is the NAT health signal; responder cardinality is
    // intentionally absent from the hub.
    expect(byDomain["nat"]!.metrics.find((metric) => metric.id === "reflection_age")!.tone).toBe("good");
    expect(byDomain["nat"]!.health).toBe("ok");
    // The current-window quality is healthy; lifetime zero buckets do not
    // participate in the state.
    expect(byDomain["counters"]!.health).toBe("ok");
    expect(byDomain["events"]!.health).toBe("ok");
    expect(byDomain["dc"]!.freshnessMs).toBe(1_756_000_000_000);
  });

  it("keeps an empty responder snapshot healthy while reflection is fresh", () => {
    const cachedReflection = {
      ...natStunLive10,
      flags: { ...natStunLive10.flags, nat_probe_attempts: 0 },
      servers: { ...natStunLive10.servers, live: [], live_total: 0 },
      reflection: { v4: { addr: "31.56.179.50:46872", age_secs: 124 } },
    };
    const runtimeWithCachedReflection = {
      ...runtimeSnapshot,
      nat_stun: { ...runtimeSnapshot.nat_stun!, data: cachedReflection },
    };
    const card = buildHubCards(inputs({ runtime: topic<RuntimeTopic>(runtimeWithCachedReflection) }), ru)
      .find((item) => item.domain === "nat")!;
    expect(card.metrics.find((metric) => metric.id === "reflection_families")!.text).toBe("IPv4");
    expect(card.metrics.find((metric) => metric.id === "reflection_age")!.tone).toBe("good");
    expect(card.health).toBe("ok");
  });

  it("reports an error only after a probe failure without reflection", () => {
    const runtimeWithNoStun = {
      ...runtimeSnapshot,
      nat_stun: { ...runtimeSnapshot.nat_stun!, data: natStunLive0 },
    };
    const card = buildHubCards(inputs({ runtime: topic<RuntimeTopic>(runtimeWithNoStun) }), ru)
      .find((item) => item.domain === "nat")!;
    expect(card.metrics.find((metric) => metric.id === "reflection_families")!.text).toBe(ru.hub.values.none);
    expect(card.metrics.find((metric) => metric.id === "reflection_age")!.tone).toBe("bad");
    expect(card.health).toBe("error");
  });

  it("promotes closed client admission to the highest-priority connection error", () => {
    const closed: StatsSnapshot = {
      ...statsSnapshot,
      ready: { ...statsSnapshot.ready!, ready: true, admission_open: false },
    };
    const card = buildHubCards(inputs({ stats: topic<StatsSnapshot>(closed) }), ru)
      .find((item) => item.domain === "connections")!;
    expect(card.metrics.find((metric) => metric.id === "admission")!.text).toBe(ru.hub.values.closed);
    expect(card.health).toBe("error");
  });

  it("warns when API access has no whitelist", () => {
    const insecure: SecurityTopic = {
      ...securitySnapshot,
      posture: { ...securitySnapshot.posture!, api_whitelist_enabled: false },
      whitelist: { ...securitySnapshot.whitelist!, enabled: false, entries_total: 0 },
    };
    const card = buildHubCards(inputs({ security: topic<SecurityTopic>(insecure) }), ru)
      .find((item) => item.domain === "security")!;
    expect(card.metrics.find((metric) => metric.id === "whitelist_state")!.text).toBe(
      ru.hub.values.unrestricted,
    );
    expect(card.health).toBe("warn");
  });

  it("derives counter health from the current 15-minute quality window", () => {
    const card = buildHubCards(
      inputs({
        history: {
          attempts: history("attempts", 1_000, 2_000),
          refusals: history("refusals", 100, 150),
        },
      }),
      ru,
    ).find((item) => item.domain === "counters")!;
    expect(card.metrics.find((metric) => metric.id === "quality")!.text).toBe("95 %");
    expect(card.health).toBe("warn");
  });

  it("shows the latest event while treating ring eviction as non-health evidence", () => {
    const recent = runtimeSnapshot.recent_events!.data!;
    const runtime: RuntimeTopic = {
      ...runtimeSnapshot,
      recent_events: {
        ...runtimeSnapshot.recent_events!,
        data: {
          ...recent,
          dropped_total: 9_999,
          events: [
            {
              seq: 999,
              ts_epoch_secs: Math.floor(NOW / 1000) - 60,
              event_type: "admission.state",
              context: "generation=1 accepting_new_connections=true",
            },
          ],
        },
      },
    };
    const card = buildHubCards(inputs({ runtime: topic<RuntimeTopic>(runtime) }), ru)
      .find((item) => item.domain === "events")!;
    expect(card.metrics.find((metric) => metric.id === "event_type")!.text).toBe(
      ru.hub.values.admissionOpen,
    );
    expect(card.metrics.map((metric) => metric.id)).not.toContain("dropped_total");
    expect(card.health).toBe("ok");
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

  it("caps an over-provisioned fleet at 100 %, as Telemt caps each DC", () => {
    // The live shape that produced «Покрытие 102,3 %» on Пульс: 44 alive
    // against 43 required, because required_writers is a floor. Telemt's own
    // per-DC coverage_pct clamps (pool_status.rs::ratio_pct), so an
    // unclamped aggregate also made the hub disagree with the DC Details
    // tiles it summarizes.
    const over = [
      { ...fleet[0]!, required_writers: 40, alive_writers: 41 },
      { ...fleet[0]!, required_writers: 3, alive_writers: 3 },
    ];
    expect(over.reduce((n, dc) => n + dc.alive_writers, 0)).toBe(44);
    expect(over.reduce((n, dc) => n + dc.required_writers, 0)).toBe(43);
    expect(dcFleetCoverage(over)).toBe(100);
  });

  it("still weighs a shortfall by required writers rather than clamping it away", () => {
    const short = [
      { ...fleet[0]!, required_writers: 40, alive_writers: 10 },
      { ...fleet[0]!, required_writers: 2, alive_writers: 2 },
    ];
    expect(dcFleetCoverage(short)).toBeCloseTo((12 / 42) * 100, 6);
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
    nat_stun: gatedOff("source_unavailable"),
    recent_events: gatedOff(),
  };

  it("shows the disabled hint instead of a row of dashes", () => {
    const cards = buildHubCards(inputs({ runtime: topic<RuntimeTopic>(off) }), ru);
    // Each card names ITS OWN gate, resolved from (endpoint, reason): events
    // rides runtime_edge and says so on `feature_disabled`; nat_stun is in
    // the always-registered runtime group (07-telemt-sdk.md §57) that NO flag
    // gates, so its only closed path is `source_unavailable` — the ME pool.
    // One hint for both would send an operator to the wrong setting half the
    // time, and naming a flag on NAT/STUN sends them to an inert one.
    const expected = {
      nat: { reason: "source_unavailable", hint: "me_pool_unavailable" },
      events: { reason: "feature_disabled", hint: "runtime_edge" },
    } as const;
    for (const domain of ["nat", "events"] as const) {
      const card = cards.find((c) => c.domain === domain)!;
      expect(card.status).toBe("disabled");
      expect(card.pill).toBe("muted");
      expect(card.metrics).toEqual([]);
      expect(card.gate).toEqual({ variant: "disabled", ...expected[domain] });
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
    const hints = {
      nat: "me_pool_unavailable",
      events: "runtime_edge",
      connections: "runtime_edge",
    } as const;
    for (const domain of ["nat", "events", "connections"] as const) {
      const card = cards.find((c) => c.domain === domain)!;
      expect(card.status, domain).toBe("disabled");
      expect(card.pill, domain).toBe("muted");
      expect(card.metrics, domain).toEqual([]);
      // No wire reason to quote — GatedNote's localized default carries it.
      expect(card.gate, domain).toEqual({ variant: "disabled", hint: hints[domain] });
    }
  });

  it("turns middle_proxy_enabled: false into the DC and ME cards' own gate", () => {
    const dcs = upstreamsSnapshot.dcs!;
    const meWriters = upstreamsSnapshot.me_writers!;
    const cards = buildHubCards(
      inputs({
        upstreams: topic<UpstreamsTopic>({
          ...upstreamsSnapshot,
          dcs: { ...dcs, middle_proxy_enabled: false, reason: "feature_disabled" },
          me_writers: { ...meWriters, middle_proxy_enabled: false, reason: "source_unavailable" },
        }),
      }),
      ru,
    );
    // Both cards read the same pair of /v1/stats/* routes, so the reason —
    // not the card — decides the follow-up: the flag when Telemt says
    // `feature_disabled`, the ME pool when it says `source_unavailable`.
    const expected = {
      dc: { reason: "feature_disabled", hint: "minimal_runtime_enabled" },
      me: { reason: "source_unavailable", hint: "me_pool_unavailable" },
    } as const;
    for (const domain of ["dc", "me"] as const) {
      const card = cards.find((c) => c.domain === domain)!;
      expect(card.status).toBe("disabled");
      expect(card.gate).toEqual({ variant: "disabled", ...expected[domain] });
    }
  });

  it("keeps NAT/STUN off every config flag whatever reason arrives", () => {
    // The regression this pins: /v1/runtime/nat-stun is dispatched
    // unconditionally and build_runtime_nat_stun_data takes no ApiConfig, so
    // no reason on that route may ever produce a "flip this setting" hint.
    const flagHints = ["runtime_edge", "minimal_runtime_enabled"];
    for (const reason of ["source_unavailable", "feature_disabled", "whatever"]) {
      const cards = buildHubCards(
        inputs({
          runtime: topic<RuntimeTopic>({ ...runtimeSnapshot, nat_stun: gatedOff(reason) }),
        }),
        ru,
      );
      const card = cards.find((c) => c.domain === "nat")!;
      expect(card.gate?.hint, reason).toBe("me_pool_unavailable");
      expect(flagHints, reason).not.toContain(card.gate?.hint);
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
        web: topic<WebTopic>(null),
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

// The WEB card (M4 task 8b) is the ninth, and the only one whose gate has
// three distinguishable causes on the wire.
describe("the WEB card", () => {
  function webCard(web: TopicSnapshot<WebTopic>) {
    return buildHubCards(inputs({ web }), ru).find((c) => c.domain === "web")!;
  }

  it("previews the runtime's own three figures when WEB is running", () => {
    const card = webCard(topic<WebTopic>(webTopicRunning));
    expect(card.status).toBe("ready");
    expect(card.gate).toBeNull();
    expect(card.metrics.map((m) => m.id)).toEqual(["lifecycle", "sessions", "streams"]);
    expect(card.metrics[0]?.text).toBe("running");
    // The lifecycle tile is toned, and «running» is the good tone — the
    // pill and the tile must not disagree about the same fact.
    expect(card.metrics[0]?.tone).toBe("good");
  });

  it("reads a WEB runtime that is off as DISABLED, with the [web] hint", () => {
    const card = webCard(topic<WebTopic>(webTopicDisabled));
    expect(card.status).toBe("disabled");
    expect(card.gate).toEqual({
      variant: "disabled",
      reason: "no_web_listener",
      hint: "web_enabled",
    });
    // A gated card shows no figures at all — never a row of dashes
    // pretending to be a reading.
    expect(card.metrics).toEqual([]);
  });

  it("reads a build with no WEB routes as UNSUPPORTED, with the update hint (R5)", () => {
    const card = webCard(topic<WebTopic>(webTopicUnsupported));
    expect(card.status).toBe("unsupported");
    expect(card.gate?.variant).toBe("unsupported");
    // R5: never a setting the operator's binary does not have.
    expect(card.gate?.hint).toBe("telemt_outdated");
  });

  it("uses the WEB catalog scope for its tile names, not a global entry", () => {
    // `manager.sessions` and `streams.live` are words other domains use
    // too; the card must read them through the endpoint-scoped catalog or
    // it would label them from somebody else's entry (R9).
    const card = webCard(topic<WebTopic>(webTopicRunning));
    expect(card.metrics.map((m) => m.label)).toEqual([
      ru.details.fields.shortLabels["web.lifecycle"],
      ru.details.fields.shortLabels["web.manager.sessions"],
      ru.details.fields.shortLabels["web.streams.live"],
    ]);
  });
});
