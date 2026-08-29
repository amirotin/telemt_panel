import { useNavigate } from "@tanstack/react-router";
import { useSnapshot } from "../../realtime";
import type { RuntimeTopic } from "../../realtime/topics";
import { DetailPage } from "../details-builder/DetailPage";
import { eventsPageDefinition } from "../details-builder/definitions/events";
import { useDetailSources, type DetailSourceInput } from "../details-builder/sources";
import { resolveGated } from "../widgets/gated";
import { eventsPagePayload } from "./events.helpers";

// EventsPage — /pulse/diag/events, spec §23.5. The domain's FIRST page: the
// `recent_events` widget showed the last few lines and had nothing behind
// it, so a reader who wanted the other 45 records had no screen to open.
//
// The adapter does one thing — nest the ring buffer's two numbers, so the
// TLS domain's `capacity`/`dropped_total` cannot describe them (§8.2).
export function EventsPage() {
  const runtime = useSnapshot<RuntimeTopic>("runtime");
  const navigate = useNavigate();

  const events = runtime.data ? resolveGated(runtime.data.recent_events) : null;
  const payload = eventsPagePayload(events?.status === "ok" ? events.data : null);

  const inputs: Record<string, DetailSourceInput> = {
    events: { kind: "topic", snapshot: runtime, gated: runtime.data?.recent_events ?? null },
  };
  const sources = useDetailSources(eventsPageDefinition.sources, inputs);

  return (
    <DetailPage
      definition={eventsPageDefinition}
      payload={payload}
      sources={sources}
      onBack={() => void navigate({ to: "/pulse" })}
      disabledHints={{ events: "runtime_edge" }}
    />
  );
}
