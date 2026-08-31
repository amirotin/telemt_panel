import type { WebSessionRow } from "../../lib/api/generated/types.gen";
import type { WebPagePayload, WebPageRuntime } from "./web.helpers";

export type WebSessionFilter = "all" | "healthy" | "provisional" | "https-lanes" | "websocket";

export type WebCapacityTone = "calm" | "warn" | "bad" | "busy";

export interface WebCapacityReading {
  id: "sessions" | "streams" | "http" | "queue" | "websocket";
  value: number | null;
  limit: number | null;
  percent: number | null;
  tone: WebCapacityTone;
  bytes: boolean;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function webLimit(runtime: WebPageRuntime | null | undefined, name: string): number | null {
  return finiteNumber(runtime?.limits[name]);
}

export function webRatio(value: number | null, limit: number | null): number | null {
  if (value === null || limit === null || limit <= 0) return null;
  return Math.min(100, Math.round((value / limit) * 100));
}

export function webCapacityTone(percent: number | null): WebCapacityTone {
  if (percent === null) return "busy";
  if (percent >= 90) return "bad";
  if (percent >= 75) return "warn";
  return "calm";
}

function reading(
  id: WebCapacityReading["id"],
  value: number | null,
  limit: number | null,
  bytes = false,
): WebCapacityReading {
  const percent = webRatio(value, limit);
  return { id, value, limit, percent, tone: webCapacityTone(percent), bytes };
}

export function webCapacityReadings(payload: WebPagePayload | null): WebCapacityReading[] {
  const runtime = payload?.runtime;
  const http = runtime?.permits.find((permit) => permit.name === "http_connections");
  return [
    reading(
      "sessions",
      finiteNumber(runtime?.manager?.sessions),
      webLimit(runtime, "max_sessions_global"),
    ),
    reading(
      "streams",
      finiteNumber(runtime?.streams?.live),
      webLimit(runtime, "max_streams_global"),
    ),
    reading(
      "http",
      finiteNumber(http?.used),
      finiteNumber(http?.capacity) ?? webLimit(runtime, "max_http_connections"),
    ),
    reading(
      "queue",
      finiteNumber(runtime?.budget?.queue_bytes),
      webLimit(runtime, "pending_bytes_global"),
      true,
    ),
    reading(
      "websocket",
      finiteNumber(runtime?.budget?.websocket_bytes),
      webLimit(runtime, "websocket_bytes_global"),
      true,
    ),
  ];
}

export function webSessionMatches(
  row: WebSessionRow,
  filter: WebSessionFilter,
  query: string,
): boolean {
  const matchesFilter = filter === "all" || row.state === filter || row.carrier === filter;
  if (!matchesFilter) return false;
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [
    row.user,
    row.client_ip,
    row.host,
    row.session_ref,
    row.user_agent ?? "",
    row.user_agent_id ?? "",
    row.key_id,
  ]
    .join(" ")
    .toLocaleLowerCase()
    .includes(needle);
}

export function webSessionStateTone(state: string): "good" | "warn" | "neutral" {
  if (state === "healthy" || state === "committed") return "good";
  if (state === "provisional") return "warn";
  return "neutral";
}

export function webHasCapacityPressure(readings: readonly WebCapacityReading[]): boolean {
  return readings.some((item) => item.tone === "warn" || item.tone === "bad");
}
