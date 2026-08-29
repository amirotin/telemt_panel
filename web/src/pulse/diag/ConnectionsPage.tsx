import { useNavigate } from "@tanstack/react-router";
import { useSnapshot } from "../../realtime";
import type { StatsSnapshot, UsersTopic } from "../../realtime/topics";
import { RUNTIME_EDGE_HINTS } from "../../caps";
import { DetailPage } from "../details-builder/DetailPage";
import { connectionsPageDefinition } from "../details-builder/definitions/connections";
import { useDetailSources, type DetailSourceInput } from "../details-builder/sources";
import { resolveGated } from "../widgets/gated";
import { connectionsPagePayload, usersTrafficTotal } from "./connections.helpers";

// ConnectionsPage — /pulse/diag/connections, spec §23.5. The two top-10
// lists the old page flattened into thirty KV rows are now two
// RankingSections built from definitions/connections.ts.
//
// The `users` topic is subscribed purely for the lifetime traffic total the
// summary block carries — Пульс's «Трафик (15 мин)» row is a per-window
// delta by design, so the cumulative number needs a home. It is NOT a
// declared source: an unfinished users poll leaves that ONE row saying it
// did not arrive, which is a smaller claim than marking the whole page
// partial over a figure the endpoint itself never sends.
export function ConnectionsPage() {
  const stats = useSnapshot<StatsSnapshot>("stats");
  const users = useSnapshot<UsersTopic>("users");
  const navigate = useNavigate();

  const gated = stats.data ? resolveGated(stats.data.connections_summary) : null;
  const payload = connectionsPagePayload(
    stats.data?.summary,
    gated?.status === "ok" ? gated.data : null,
    usersTrafficTotal(users.data),
  );

  const inputs: Record<string, DetailSourceInput> = {
    stats: { kind: "topic", snapshot: stats },
    connections: {
      kind: "topic",
      snapshot: stats,
      gated: stats.data?.connections_summary ?? null,
    },
  };
  const sources = useDetailSources(connectionsPageDefinition.sources, inputs);

  return (
    <DetailPage
      definition={connectionsPageDefinition}
      payload={payload}
      sources={sources}
      onBack={() => void navigate({ to: "/pulse" })}
      disabledHints={{ connections: RUNTIME_EDGE_HINTS }}
    />
  );
}
