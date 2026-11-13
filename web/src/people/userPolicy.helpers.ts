import type { User } from "../lib/api/generated/types.gen";
import type { LimitFieldState } from "./buildUserPatch";

export function configuredUserLimit(user: Pick<User, "limits" | "max_tcp_conns" | "max_unique_ips">, key: "max_tcp_conns" | "max_unique_ips"): number | undefined {
  return (user.limits ? user.limits.desired[key].configured_override : user[key]) || undefined;
}

export function sourceDenyLines(value: string): string[] {
  return value.split("\n").map(line => line.trim()).filter(Boolean);
}

export function sourceDenyPatch(value: string, original?: string[]): LimitFieldState<string[]> {
  const lines = sourceDenyLines(value);
  return JSON.stringify(lines) === JSON.stringify(original ?? []) ? { mode: "keep" } : { mode: "set", value: lines };
}
