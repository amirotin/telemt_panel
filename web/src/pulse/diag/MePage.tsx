import { useNavigate } from "@tanstack/react-router";
import { useSnapshot } from "../../realtime";
import type { RuntimeTopic, UpstreamsTopic } from "../../realtime/topics";
import { ME_POOL_RUNTIME_HINTS, MINIMAL_STATS_HINTS } from "../../caps";
import { DetailPage } from "../details-builder/DetailPage";
import { mePageDefinition } from "../details-builder/definitions/me";
import { useDetailSources, type DetailSourceInput } from "../details-builder/sources";
import { resolveGated } from "../widgets/gated";
import { mePagePayload } from "./me.helpers";

// MePage — /pulse/diag/me, spec §23.2. The thirteen KV groups the old page
// flattened into ~1 091 rows are now five tabs built from
// definitions/me.ts; this component owns only the two subscriptions and the
// four source states.
//
// The three runtime_edge payloads (pool, quality, self-test) share ONE
// source id because they share one gate: they fail together, and reporting
// them as three degraded sources would say the same sentence three times in
// the attention card.
export function MePage() {
  const upstreams = useSnapshot<UpstreamsTopic>("upstreams");
  const runtime = useSnapshot<RuntimeTopic>("runtime");
  const navigate = useNavigate();

  const meWriters = upstreams.data?.me_writers ?? null;
  const pool = runtime.data ? resolveGated(runtime.data.me_pool_state) : null;
  const quality = runtime.data ? resolveGated(runtime.data.me_quality) : null;
  const selftest = runtime.data ? resolveGated(runtime.data.me_selftest) : null;
  const minimal = runtime.data ? resolveGated(runtime.data.minimal) : null;

  const payload = mePagePayload({
    meWriters,
    gates: runtime.data?.gates ?? null,
    initialization: runtime.data?.initialization ?? null,
    pool: pool?.status === "ok" ? pool.data : undefined,
    quality: quality?.status === "ok" ? quality.data : undefined,
    selftest: selftest?.status === "ok" ? selftest.data : undefined,
    meRuntime: minimal?.status === "ok" ? minimal.data.me_runtime : undefined,
  });

  const inputs: Record<string, DetailSourceInput> = {
    upstreams: {
      kind: "topic",
      snapshot: upstreams,
      // middle_proxy_enabled is Telemt's own gate on the whole ME view: with
      // it off there is no pool to describe, and the reason is the proxy's
      // own word for why (spec §14, R5).
      ...(meWriters
        ? {
            gated: {
              enabled: meWriters.middle_proxy_enabled,
              ...(meWriters.reason !== undefined ? { reason: meWriters.reason } : {}),
              data: meWriters.writers,
            },
          }
        : {}),
      generatedAt: meWriters?.generated_at_epoch_secs ?? null,
    },
    runtime: { kind: "topic", snapshot: runtime },
    runtime_edge: {
      kind: "topic",
      snapshot: runtime,
      gated: runtime.data?.me_pool_state ?? null,
    },
    minimal: { kind: "topic", snapshot: runtime, gated: runtime.data?.minimal ?? null },
  };
  const sources = useDetailSources(mePageDefinition.sources, inputs);

  return (
    <DetailPage
      definition={mePageDefinition}
      payload={payload}
      sources={sources}
      onBack={() => void navigate({ to: "/pulse" })}
      // `runtime_edge` is this page's SOURCE id, not its gate: the payload
      // behind it is /v1/runtime/me-pool-state, which no flag gates.
      disabledHints={{
        upstreams: MINIMAL_STATS_HINTS,
        runtime_edge: ME_POOL_RUNTIME_HINTS,
        minimal: MINIMAL_STATS_HINTS,
      }}
    />
  );
}
