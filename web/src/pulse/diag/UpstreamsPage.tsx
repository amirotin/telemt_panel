import { useNavigate } from "@tanstack/react-router";
import { useSnapshot } from "../../realtime";
import type { RuntimeTopic, UpstreamsTopic } from "../../realtime/topics";
import { DetailPage } from "../details-builder/DetailPage";
import { upstreamsPageDefinition } from "../details-builder/definitions/upstreams";
import { useDetailSources, type DetailSourceInput } from "../details-builder/sources";
import { upstreamsPagePayload } from "./upstreams.helpers";

// UpstreamsPage — /pulse/diag/upstreams, spec §23.5. The two endpoints that
// used to produce «Апстримы #0» and «Качество апстрима #0» as separate KV
// groups are merged by `upstream_id` into one EntityListSection; what is on
// the screen is definitions/upstreams.ts and what every field MEANS is the
// field catalog.
export function UpstreamsPage() {
  const upstreams = useSnapshot<UpstreamsTopic>("upstreams");
  const runtime = useSnapshot<RuntimeTopic>("runtime");
  const navigate = useNavigate();

  const stats = upstreams.data?.upstreams ?? null;
  const quality = runtime.data?.upstream_quality ?? null;
  const payload = upstreamsPagePayload(stats, quality);

  const inputs: Record<string, DetailSourceInput> = {
    upstreams: {
      kind: "topic",
      snapshot: upstreams,
      // `enabled` is Telemt's own gate on the whole upstream view, and the
      // reason is the proxy's own word for why (spec §14, R5). The gate's
      // payload is the RESPONSE, not `upstreams[]`: a proxy with no upstream
      // configured still reports counters and route totals, and the list's
      // own empty state is what says there is no route (§10.3).
      ...(stats
        ? {
            gated: {
              enabled: stats.enabled,
              ...(stats.reason !== undefined ? { reason: stats.reason } : {}),
              data: stats,
            },
          }
        : {}),
      generatedAt: stats?.generated_at_epoch_secs ?? null,
    },
    // upstream_quality is a bespoke flat shape rather than Gated<T>
    // (realtime/topics.ts), so the wrapper is built here: `enabled` is the
    // same minimal_runtime_enabled gate, and `policy` is what the source
    // actually feeds.
    quality: {
      kind: "topic",
      snapshot: runtime,
      ...(quality
        ? {
            gated: {
              enabled: quality.enabled,
              ...(quality.reason !== undefined ? { reason: quality.reason } : {}),
              data: quality.policy,
            },
          }
        : {}),
      generatedAt: quality?.generated_at_epoch_secs ?? null,
    },
  };
  const sources = useDetailSources(upstreamsPageDefinition.sources, inputs);

  return (
    <DetailPage
      definition={upstreamsPageDefinition}
      payload={payload}
      sources={sources}
      onBack={() => void navigate({ to: "/pulse" })}
      disabledHints={{ quality: "minimal_runtime_enabled" }}
    />
  );
}
