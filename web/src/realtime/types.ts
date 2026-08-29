// TopicName mirrors internal/hub's topic set (02-hub-sse.md).
export type TopicName = "users" | "stats" | "runtime" | "upstreams" | "security" | "web" | "update";

// TopicSnapshot is what useSnapshot(topic) hands back. `data` is the last
// good payload — it is NEVER cleared just because the topic went stale
// (02-hub-sse.md: "UI показывает стейл-индикатор, данные не сбрасывает").
// `stale`/`error` reflect a per-topic `source_error` frame; the *global*
// connection staleness (no frame of any kind for 40s) is a separate
// concern, see ConnectionSnapshot.
export interface TopicSnapshot<T = unknown> {
  data: T | null;
  ts: number | null;
  stale: boolean;
  error: string | null;
}

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "polling" | "closed";

export interface ConnectionSnapshot {
  status: ConnectionStatus;
  /** No SSE frame (event or heartbeat) received for 40s. */
  stale: boolean;
}
