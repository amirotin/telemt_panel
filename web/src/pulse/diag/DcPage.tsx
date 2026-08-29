import { useNavigate } from "@tanstack/react-router";
import { useSnapshot } from "../../realtime";
import type { RuntimeTopic, UpstreamsTopic } from "../../realtime/topics";
import { MINIMAL_STATS_HINTS } from "../../caps";
import { DetailPage } from "../details-builder/DetailPage";
import { dcPageDefinition } from "../details-builder/definitions/dc";
import { useDetailSources, type DetailSourceInput } from "../details-builder/sources";
import { resolveGated } from "../widgets/gated";
import { dcPagePayload } from "./dc.helpers";

// DcPage — /pulse/diag/dc, the first page built entirely from a
// declarative definition (M4 task 6, spec §23.1). The component owns only
// the two subscriptions and the source states; what is on the screen and in
// what order is definitions/dc.ts, and what every field MEANS is the field
// catalog.
export function DcPage() {
  const upstreams = useSnapshot<UpstreamsTopic>("upstreams");
  const runtime = useSnapshot<RuntimeTopic>("runtime");
  const navigate = useNavigate();

  const dcs = upstreams.data?.dcs ?? null;
  // network_path (mini-task 2c) rides the separately gated `minimal`
  // payload. `resolveGated` already separates "switched off" from "the
  // build has no such thing" (ruling R5); handing the wrapper to the source
  // resolver is what turns that into the page's own degraded state instead
  // of a silently missing section.
  const minimal = runtime.data ? resolveGated(runtime.data.minimal) : null;
  const networkPaths = minimal?.status === "ok" ? minimal.data.network_path : [];
  const payload = dcPagePayload(dcs, networkPaths);

  const inputs: Record<string, DetailSourceInput> = {
    upstreams: {
      kind: "topic",
      snapshot: upstreams,
      // middle_proxy_enabled is Telemt's own gate on the whole DC view: with
      // it off there are no data centers to show, and the reason is the
      // proxy's own word for why (spec §14, R5).
      ...(dcs
        ? {
            gated: {
              enabled: dcs.middle_proxy_enabled,
              ...(dcs.reason !== undefined ? { reason: dcs.reason } : {}),
              data: dcs.dcs,
            },
          }
        : {}),
      generatedAt: dcs?.generated_at_epoch_secs ?? null,
    },
    runtime: { kind: "topic", snapshot: runtime, gated: runtime.data?.minimal ?? null },
  };
  const sources = useDetailSources(dcPageDefinition.sources, inputs);

  return (
    <DetailPage
      definition={dcPageDefinition}
      payload={payload}
      sources={sources}
      onBack={() => void navigate({ to: "/pulse" })}
      disabledHints={{ upstreams: MINIMAL_STATS_HINTS, runtime: MINIMAL_STATS_HINTS }}
    />
  );
}
