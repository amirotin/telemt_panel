import { useNavigate } from "@tanstack/react-router";
import { useSnapshot } from "../../realtime";
import type { RuntimeTopic } from "../../realtime/topics";
import { DetailPage } from "../details-builder/DetailPage";
import { natPageDefinition } from "../details-builder/definitions/nat";
import { useDetailSources, type DetailSourceInput } from "../details-builder/sources";
import { resolveGated } from "../widgets/gated";

// NatPage — /pulse/diag/nat, spec §23.5. The three flattened KV groups the
// old page produced are now definitions/nat.ts: the configured and live
// server lists get array blocks of their own, and both reflection families
// are named whether or not they answered.
//
// No adapter: the page payload IS the gated `nat_stun` object, so there is
// nothing to join and `nat.helpers.ts` went away with the groups it built.
export function NatPage() {
  const runtime = useSnapshot<RuntimeTopic>("runtime");
  const navigate = useNavigate();

  const nat = runtime.data ? resolveGated(runtime.data.nat_stun) : null;
  const payload = nat?.status === "ok" ? nat.data : null;

  const inputs: Record<string, DetailSourceInput> = {
    nat: { kind: "topic", snapshot: runtime, gated: runtime.data?.nat_stun ?? null },
  };
  const sources = useDetailSources(natPageDefinition.sources, inputs);

  return (
    <DetailPage
      definition={natPageDefinition}
      payload={payload}
      sources={sources}
      onBack={() => void navigate({ to: "/pulse" })}
      // The minimal runtime group's gate, not runtime_edge — see the `nat`
      // entry in hub/hubCards.ts.
      disabledHints={{ nat: "minimal_runtime_enabled" }}
    />
  );
}
