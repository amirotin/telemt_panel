import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { en } from "../../i18n/en";
import { ru } from "../../i18n/ru";
import type { TopicSnapshot } from "../../realtime/types";
import { resolveTlsFingerprintsQuery } from "../widgets/tlsFingerprints.helpers";
import type { DataSourceDefinition } from "./model";
import {
  aggregateSources,
  gatedStatus,
  hintKeyFor,
  isEmptyPayload,
  noticeVariantFor,
  normalizeFreshness,
  resolveQuerySource,
  resolveTopicSource,
  sourceStatusLabel,
  useDetailSources,
  type QuerySourceInput,
  type SourceState,
  type SourceStatus,
} from "./sources";
import { gatedOff, gatedUnavailable, tlsFingerprints } from "./__fixtures__";

function snapshot<T>(over: Partial<TopicSnapshot<T>> = {}): TopicSnapshot<T> {
  return { data: null, ts: null, stale: false, error: null, ...over };
}

describe("freshness normalization", () => {
  it("turns useSnapshot's seconds and React Query's milliseconds into one scale", () => {
    // useSnapshot(topic).ts is seconds; dataUpdatedAt is ms.
    expect(normalizeFreshness(1756000000)).toBe(1756000000000);
    expect(normalizeFreshness(1756000000000)).toBe(1756000000000);
  });

  it("treats no timestamp as no timestamp, not as the epoch", () => {
    expect(normalizeFreshness(null)).toBeNull();
    expect(normalizeFreshness(undefined)).toBeNull();
    expect(normalizeFreshness(0)).toBeNull();
    expect(normalizeFreshness(Number.NaN)).toBeNull();
  });
});

describe("SSE topic sources (spec §14)", () => {
  it("is loading before the first frame and error only when nothing was ever shown", () => {
    expect(resolveTopicSource("t", { kind: "topic", snapshot: snapshot() }).status).toBe("loading");
    expect(
      resolveTopicSource("t", { kind: "topic", snapshot: snapshot({ error: "boom" }) }).status,
    ).toBe("error");
  });

  it("keeps the last payload and flags it stale rather than blanking the page (§19.3)", () => {
    const state = resolveTopicSource("t", {
      kind: "topic",
      snapshot: snapshot({ data: { a: 1 }, ts: 1756000000, stale: true }),
    });
    expect(state.status).toBe("stale");
    expect(state.hasData).toBe(true);
    expect(state.freshnessMs).toBe(1756000000000);
  });

  it("prefers the payload's own generation stamp over the frame's arrival time", () => {
    const state = resolveTopicSource("t", {
      kind: "topic",
      snapshot: snapshot({ data: { a: 1 }, ts: 1756000900 }),
      generatedAt: 1756000000,
    });
    expect(state.freshnessMs).toBe(1756000000000);
  });

  it("lets a capability-off gate beat a cached payload (TlsSourceNotice's ordering)", () => {
    const state = resolveTopicSource("t", {
      kind: "topic",
      snapshot: snapshot({ data: { a: 1 }, ts: 1756000000 }),
      gated: gatedOff("feature_disabled"),
    });
    expect(state.status).toBe("disabled");
    expect(state.reason).toBe("feature_disabled");
    expect(state.hasData).toBe(false);
  });

  it("calls a successful but data-less answer `empty`, gate or no gate (§14)", () => {
    // §14's `empty` is "запрос успешен, данных нет" — it is not a property
    // of Gated<T>. A topic that honestly answered [] or {} says so.
    expect(
      resolveTopicSource("t", { kind: "topic", snapshot: snapshot({ data: [] }) }).status,
    ).toBe("empty");
    expect(
      resolveTopicSource("t", { kind: "topic", snapshot: snapshot({ data: {} }) }).status,
    ).toBe("empty");
    // An object whose every top-level container is empty is empty too…
    expect(
      resolveTopicSource("t", {
        kind: "topic",
        snapshot: snapshot({ data: { writers: [], by_dc: {} } }),
      }).status,
    ).toBe("empty");
    // …but one scalar anywhere means the source said something.
    expect(
      resolveTopicSource("t", {
        kind: "topic",
        snapshot: snapshot({ data: { writers: [], total: 0 } }),
      }).status,
    ).toBe("ready");
    expect(
      resolveQuerySource("q", { kind: "query", isPending: false, isError: false, data: [] }).status,
    ).toBe("empty");
  });

  it("does not mistake a falsy scalar payload for no data", () => {
    // `0` and `false` are real values everywhere else (§13.1); the source
    // state must agree.
    expect(isEmptyPayload({ a: 0 })).toBe(false);
    expect(isEmptyPayload({ a: false })).toBe(false);
    expect(isEmptyPayload({ a: null })).toBe(true);
    expect(isEmptyPayload([])).toBe(true);
    expect(isEmptyPayload({})).toBe(true);
  });

  it("calls an enabled-but-empty gate `empty`, not `error` and not `disabled`", () => {
    const state = resolveTopicSource("t", {
      kind: "topic",
      snapshot: snapshot({ data: { a: 1 } }),
      gated: gatedUnavailable(),
    });
    expect(state.status).toBe("empty");
  });
});

describe("ruling R5: unsupported is not disabled", () => {
  it("maps an old build to unsupported and a switched-off capability to disabled", () => {
    expect(gatedStatus(gatedOff("feature_disabled"))).toBe("disabled");
    expect(gatedStatus(gatedOff("capability_absent"))).toBe("unsupported");
    expect(gatedStatus(gatedOff("feature_disabled"), { buildTooOld: true })).toBe("unsupported");
  });

  it("maps 503 to disabled and 501 to unsupported on a REST source", () => {
    const base: QuerySourceInput = { kind: "query", isPending: false, isError: true };
    expect(
      resolveQuerySource("q", { ...base, error: { code: "capability_unavailable" } }).status,
    ).toBe("disabled");
    expect(resolveQuerySource("q", { ...base, error: { code: "capability_absent" } }).status).toBe(
      "unsupported",
    );
  });

  it("agrees with the TLS widget's own state machine, case by case", () => {
    // The R5 split must not drift apart between widgets/tlsFingerprints
    // (Task 1's reference implementation) and the builder.
    const cases: Array<[QuerySourceInput, string]> = [
      [{ kind: "query", isPending: true, isError: false }, "loading"],
      [
        { kind: "query", isPending: false, isError: true, error: { code: "capability_unavailable" } },
        "disabled",
      ],
      [
        { kind: "query", isPending: false, isError: true, error: { code: "capability_absent" } },
        "unsupported",
      ],
      [
        { kind: "query", isPending: false, isError: true, error: { code: "internal_error" } },
        "error",
      ],
    ];
    for (const [input, expected] of cases) {
      expect(resolveQuerySource("tls", input).status).toBe(expected);
      expect(
        resolveTlsFingerprintsQuery({
          isPending: input.isPending,
          isError: input.isError,
          error: input.error as never,
        }).status,
      ).toBe(expected);
    }
  });

  it("hands the existing GatedNote variant and the telemt_outdated hint back out", () => {
    const disabled: SourceState = { id: "t", status: "disabled", freshnessMs: null, hasData: false };
    const unsupported: SourceState = {
      id: "t",
      status: "unsupported",
      freshnessMs: null,
      hasData: false,
    };
    const ready: SourceState = { id: "t", status: "ready", freshnessMs: null, hasData: true };
    expect(noticeVariantFor(disabled)).toBe("disabled");
    expect(noticeVariantFor(unsupported)).toBe("unsupported");
    expect(noticeVariantFor(ready)).toBeNull();
    // Never "flip a setting your binary does not have".
    expect(hintKeyFor(unsupported, "runtime_edge")).toBe("telemt_outdated");
    expect(hintKeyFor(disabled, "runtime_edge")).toBe("runtime_edge");
    expect(hintKeyFor(ready, "runtime_edge")).toBeUndefined();
  });
});

describe("REST query sources", () => {
  it("keeps a cached payload as stale when a refetch fails", () => {
    const state = resolveQuerySource("tls", {
      kind: "query",
      isPending: false,
      isError: true,
      error: { code: "internal_error" },
      data: { enabled: true, data: tlsFingerprints },
      gated: { enabled: true, data: tlsFingerprints },
      dataUpdatedAt: 1756000000000,
    });
    expect(state.status).toBe("stale");
    expect(state.hasData).toBe(true);
    expect(state.freshnessMs).toBe(1756000000000);
  });

  it("reads a gated envelope on a 200", () => {
    expect(
      resolveQuerySource("tls", {
        kind: "query",
        isPending: false,
        isError: false,
        data: { enabled: false, reason: "feature_disabled" },
        gated: { enabled: false, reason: "feature_disabled" },
      }),
    ).toMatchObject({ status: "disabled", reason: "feature_disabled" });
  });
});

describe("page aggregate (spec §14)", () => {
  const required: DataSourceDefinition = { id: "a", required: true };
  const optional: DataSourceDefinition = { id: "b", required: false };
  const state = (id: string, status: SourceStatus, hasData = false, freshnessMs = null) =>
    ({ id, status, hasData, freshnessMs }) as SourceState;

  it("degrades to partial rather than replacing the working sections", () => {
    const page = aggregateSources([required, optional], {
      a: state("a", "ready", true),
      b: state("b", "disabled"),
    });
    expect(page.status).toBe("partial");
    expect(page.degraded).toEqual(["b"]);
  });

  it("reports the required source's own failure when it is the one that broke", () => {
    const page = aggregateSources([required, optional], {
      a: state("a", "unsupported"),
      b: state("b", "ready", true),
    });
    expect(page.status).toBe("unsupported");
  });

  it("is ready when everything is, and stale when anything shown is", () => {
    expect(
      aggregateSources([required, optional], {
        a: state("a", "ready", true),
        b: state("b", "ready", true),
      }).status,
    ).toBe("ready");
    expect(
      aggregateSources([required, optional], {
        a: state("a", "stale", true),
        b: state("b", "ready", true),
      }).status,
    ).toBe("stale");
  });

  it("takes the newest freshness across sources", () => {
    const page = aggregateSources([required, optional], {
      a: { id: "a", status: "ready", hasData: true, freshnessMs: 1000 },
      b: { id: "b", status: "ready", hasData: true, freshnessMs: 5000 },
    });
    expect(page.freshnessMs).toBe(5000);
  });

  it("is loading before any source has answered", () => {
    expect(aggregateSources([required], { a: state("a", "loading") }).status).toBe("loading");
    expect(aggregateSources([required], {}).status).toBe("loading");
  });
});

describe("useDetailSources", () => {
  const definitions: DataSourceDefinition[] = [
    { id: "upstreams", topic: "upstreams", required: true },
    { id: "tls", endpoint: "/api/telemt/tls-fingerprints", required: false },
  ];

  function render(inputs: Record<string, never>) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let captured: ReturnType<typeof useDetailSources> | null = null;
    const results: Array<ReturnType<typeof useDetailSources>> = [];
    function Harness({ value }: { value: Record<string, never> }) {
      captured = useDetailSources(definitions, value);
      results.push(captured);
      return null;
    }
    act(() => root.render(createElement(Harness, { value: inputs })));
    return {
      get state() {
        if (!captured) throw new Error("not rendered");
        return captured;
      },
      results,
      rerender(next: Record<string, never>) {
        act(() => root.render(createElement(Harness, { value: next })));
      },
      unmount() {
        act(() => root.unmount());
        container.remove();
      },
    };
  }

  it("resolves and aggregates the definition's sources", () => {
    const harness = render({
      upstreams: { kind: "topic", snapshot: snapshot({ data: { a: 1 }, ts: 1756000000 }) },
      tls: { kind: "query", isPending: false, isError: true, error: { code: "capability_absent" } },
    } as never);
    expect(harness.state.byId["upstreams"].status).toBe("ready");
    expect(harness.state.byId["tls"].status).toBe("unsupported");
    expect(harness.state.status).toBe("partial");
    expect(harness.state.freshnessMs).toBe(1756000000000);
    harness.unmount();
  });

  it("keeps its result stable when a realtime frame changes only object identity (§19.1)", () => {
    const first = {
      upstreams: { kind: "topic", snapshot: snapshot({ data: { a: 1 }, ts: 1756000000 }) },
    } as never;
    const harness = render(first);
    const before = harness.state;
    // A new frame with an identical observable state: same status, same
    // timestamp, brand-new objects all the way down.
    harness.rerender({
      upstreams: { kind: "topic", snapshot: snapshot({ data: { a: 1 }, ts: 1756000000 }) },
    } as never);
    expect(harness.state).toBe(before);
    harness.unmount();
  });

  it("does produce a new result when a source actually changes state", () => {
    const harness = render({
      upstreams: { kind: "topic", snapshot: snapshot({ data: { a: 1 }, ts: 1756000000 }) },
    } as never);
    const before = harness.state;
    harness.rerender({
      upstreams: {
        kind: "topic",
        snapshot: snapshot({ data: { a: 1 }, ts: 1756000000, stale: true }),
      },
    } as never);
    expect(harness.state).not.toBe(before);
    expect(harness.state.byId["upstreams"].status).toBe("stale");
    harness.unmount();
  });
});

describe("state labels", () => {
  it("names every §14 state in both languages", () => {
    const statuses: SourceStatus[] = [
      "loading",
      "ready",
      "stale",
      "partial",
      "disabled",
      "unsupported",
      "error",
      "empty",
    ];
    for (const dict of [ru, en]) {
      const labels = statuses.map((s) => sourceStatusLabel(s, dict));
      expect(labels.every((l) => l.length > 0)).toBe(true);
      expect(new Set(labels).size).toBe(statuses.length);
    }
  });
});
