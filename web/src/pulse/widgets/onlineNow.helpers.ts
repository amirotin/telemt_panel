import type { UsersTopicQuotaEntry, UsersTopicUser } from "../../realtime/topics";

export type ClientAttentionSeverity = "error" | "warn";

export type ClientAttentionSignal =
  | {
      kind: "quota" | "connections" | "ips";
      severity: ClientAttentionSeverity;
      current: number;
      limit: number;
      ratio: number;
    }
  | {
      kind: "expiration";
      severity: ClientAttentionSeverity;
      expiresAt: number;
      expired: boolean;
    }
  | {
      kind: "runtime";
      severity: "warn";
    };

export interface ClientAttentionRow {
  username: string;
  severity: ClientAttentionSeverity;
  signals: ClientAttentionSignal[];
}

export interface ClientConcentration {
  username: string;
  connections: number;
  sharePct: number;
}

export interface ClientAttentionView {
  rows: ClientAttentionRow[];
  attentionCount: number;
  topConcentration: ClientConcentration | null;
}

export const CLIENT_ATTENTION_LIMIT = 5;
export const CLIENT_LIMIT_WARN_RATIO = 0.8;
export const CLIENT_EXPIRY_WARN_MS = 7 * 24 * 60 * 60 * 1000;

function ratioSignal(
  kind: "quota" | "connections" | "ips",
  current: number,
  limit: number,
): ClientAttentionSignal | null {
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const ratio = current / limit;
  if (ratio < CLIENT_LIMIT_WARN_RATIO) return null;
  return {
    kind,
    severity: ratio >= 1 ? "error" : "warn",
    current,
    limit,
    ratio: Math.round(ratio * 100),
  };
}

const KIND_PRIORITY: Record<ClientAttentionSignal["kind"], number> = {
  expiration: 50,
  quota: 40,
  connections: 30,
  ips: 20,
  runtime: 10,
};

function signalScore(signal: ClientAttentionSignal): number {
  const ratio = "ratio" in signal ? signal.ratio : 0;
  return (signal.severity === "error" ? 1_000 : 0) + KIND_PRIORITY[signal.kind] + ratio;
}

function signalsForUser(
  user: UsersTopicUser,
  quota: UsersTopicQuotaEntry | undefined,
  nowMs: number,
): ClientAttentionSignal[] {
  const signals: ClientAttentionSignal[] = [];

  if (user.enabled && user.expiration_rfc3339) {
    const expiresAt = Date.parse(user.expiration_rfc3339);
    if (Number.isFinite(expiresAt) && expiresAt - nowMs <= CLIENT_EXPIRY_WARN_MS) {
      signals.push({
        kind: "expiration",
        severity: expiresAt <= nowMs ? "error" : "warn",
        expiresAt,
        expired: expiresAt <= nowMs,
      });
    }
  }

  if (user.enabled && !user.in_runtime) {
    signals.push({ kind: "runtime", severity: "warn" });
  }

  if (quota) {
    const signal = ratioSignal("quota", quota.used_bytes, quota.data_quota_bytes);
    if (signal) signals.push(signal);
  }

  if (user.max_tcp_conns !== undefined) {
    const signal = ratioSignal("connections", user.current_connections, user.max_tcp_conns);
    if (signal) signals.push(signal);
  }

  if (user.max_unique_ips !== undefined) {
    const current = Math.max(user.active_unique_ips, user.recent_unique_ips);
    const signal = ratioSignal("ips", current, user.max_unique_ips);
    if (signal) signals.push(signal);
  }

  return signals.sort((a, b) => signalScore(b) - signalScore(a));
}

/**
 * Build the overview's action queue. KPI already owns total users and total
 * connections; this card names only clients whose configured limits, expiry
 * or runtime state need an operator's attention.
 */
export function computeClientAttention(
  users: readonly UsersTopicUser[] | null | undefined,
  quota: Readonly<Record<string, UsersTopicQuotaEntry>> | null | undefined,
  nowMs: number,
  limit: number = CLIENT_ATTENTION_LIMIT,
): ClientAttentionView {
  if (!users) return { rows: [], attentionCount: 0, topConcentration: null };

  const rows = users
    .map((user): ClientAttentionRow | null => {
      const signals = signalsForUser(user, quota?.[user.username], nowMs);
      if (signals.length === 0) return null;
      return { username: user.username, severity: signals[0].severity, signals };
    })
    .filter((row): row is ClientAttentionRow => row !== null)
    .sort(
      (a, b) =>
        signalScore(b.signals[0]) - signalScore(a.signals[0]) ||
        a.username.localeCompare(b.username),
    );

  const totalConnections = users.reduce((sum, user) => sum + user.current_connections, 0);
  const busiest = [...users]
    .filter((user) => user.current_connections > 0)
    .sort(
      (a, b) =>
        b.current_connections - a.current_connections || a.username.localeCompare(b.username),
    )[0];
  const topConcentration =
    busiest && totalConnections > 0
      ? {
          username: busiest.username,
          connections: busiest.current_connections,
          sharePct: Math.round((busiest.current_connections / totalConnections) * 100),
        }
      : null;

  return {
    rows: rows.slice(0, Math.max(0, limit)),
    attentionCount: rows.length,
    topConcentration,
  };
}
