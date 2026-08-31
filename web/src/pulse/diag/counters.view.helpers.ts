import type { ZeroAllData } from "../../lib/api/generated/types.gen";
import { COUNTER_GROUP_PATHS, isFailureCounterPath, type CounterGroupPath } from "../details-builder/definitions/counters";
import { readCounterValues, type CounterSnapshot } from "./counters.helpers";

export interface BreakdownRow {
  id: string;
  total: number;
}

export interface CounterViewMetrics {
  connections: number | null;
  badConnections: number | null;
  upstreamAttempts: number | null;
  upstreamSuccess: number | null;
  upstreamFail: number | null;
  payloadBytes: number | null;
  dataFrames: number | null;
  routeDrops: number | null;
  poolEvents: number | null;
  desyncEvents: number | null;
  newFailureSignals: number | null;
}

const BREAKDOWNS: Array<[CounterGroupPath, string]> = [
  ["core", "connections_bad_by_class"],
  ["core", "handshake_failures_by_class"],
  ["middle_proxy", "handshake_error_codes"],
];

export function breakdownRows(value: unknown): BreakdownRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (item === null || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const total = row["total"];
    if (typeof total !== "number" || !Number.isFinite(total)) return [];
    const identity = row["class"] ?? row["code"] ?? row["reason"] ?? row["name"] ?? index;
    return [{ id: String(identity), total }];
  });
}

export function readCounterViewValues(data: ZeroAllData | undefined): CounterSnapshot {
  const out = readCounterValues(data);
  if (!data) return out;
  for (const [group, key] of BREAKDOWNS) {
    for (const row of breakdownRows(data[group][key])) {
      out[`${group}.${key}.${row.id}`] = row.total;
    }
  }
  return out;
}

function value(snapshot: CounterSnapshot | undefined, path: string): number | null {
  const found = snapshot?.[path];
  return found === undefined ? null : found;
}

function sumPositiveByPrefix(snapshot: CounterSnapshot | undefined, prefix: string): number | null {
  if (!snapshot) return null;
  const values = Object.entries(snapshot)
    .filter(([path]) => path.startsWith(prefix) && path.endsWith("_total"))
    .map(([, amount]) => Math.max(0, amount));
  return values.length ? values.reduce((sum, amount) => sum + amount, 0) : 0;
}

export function counterViewMetrics(window: CounterSnapshot | undefined): CounterViewMetrics {
  const failures = window
    ? Object.entries(window).filter(
        ([path, amount]) =>
          !path.includes("_by_class.") &&
          !path.includes("handshake_error_codes.") &&
          isFailureCounterPath(path) &&
          amount > 0,
      )
    : null;
  return {
    connections: value(window, "core.connections_total"),
    badConnections: value(window, "core.connections_bad_total"),
    upstreamAttempts: value(window, "upstream.connect_attempt_total"),
    upstreamSuccess: value(window, "upstream.connect_success_total"),
    upstreamFail: value(window, "upstream.connect_fail_total"),
    payloadBytes: value(window, "middle_proxy.d2c_payload_bytes_total"),
    dataFrames: value(window, "middle_proxy.d2c_data_frames_total"),
    routeDrops: window
      ? Object.entries(window)
          .filter(([path]) => path.startsWith("middle_proxy.route_drop_") && path.endsWith("_total"))
          .reduce((sum, [, amount]) => sum + Math.max(0, amount), 0)
      : null,
    poolEvents: sumPositiveByPrefix(window, "pool."),
    desyncEvents: sumPositiveByPrefix(window, "desync."),
    newFailureSignals: failures?.reduce((sum, [, amount]) => sum + amount, 0) ?? null,
  };
}

export function scalarCounterRows(data: ZeroAllData): Array<{
  group: CounterGroupPath;
  key: string;
  path: string;
  value: unknown;
}> {
  return COUNTER_GROUP_PATHS.flatMap((group) =>
    Object.entries(data[group]).flatMap(([key, current]) =>
      current !== null && typeof current === "object"
        ? []
        : [{ group, key, path: `${group}.${key}`, value: current }],
    ),
  );
}
