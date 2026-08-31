import type { TlsFingerprintRow } from "../../lib/api/generated/types.gen";
import type { SecurityPosture } from "../../realtime/topics";

export type SecurityLevel = "ok" | "warn" | "error";
export type SecurityTlsScope = "by_fingerprint" | "by_ip" | "by_cidr" | "by_user";

export function tlsTotals(rows: readonly TlsFingerprintRow[] | undefined): {
  observed: number | null;
  bad: number | null;
} {
  if (rows === undefined) return { observed: null, bad: null };
  return rows.reduce(
    (sum, row) => ({
      observed: (sum.observed ?? 0) + row.total,
      bad: (sum.bad ?? 0) + row.bad_or_probe,
    }),
    { observed: 0, bad: 0 } as { observed: number | null; bad: number | null },
  );
}
export function securityLevel(
  posture: SecurityPosture | null | undefined,
  badOrProbe: number | null,
): SecurityLevel {
  if (!posture) return badOrProbe !== null && badOrProbe > 0 ? "warn" : "ok";
  if (!posture.api_whitelist_enabled && !posture.api_auth_header_enabled && !posture.api_read_only) {
    return "error";
  }
  if (!posture.api_whitelist_enabled || (badOrProbe !== null && badOrProbe > 0)) return "warn";
  return "ok";
}

export function tlsRowIdentity(row: TlsFingerprintRow, scope: SecurityTlsScope): string {
  return scope === "by_fingerprint" ? row.ja4 || row.ja3 : row.scope || row.ja4 || row.ja3;
}

export function tlsRowSecondary(row: TlsFingerprintRow, scope: SecurityTlsScope): string {
  return scope === "by_fingerprint" ? row.ja3 : row.ja4 || row.ja3;
}

export function filterTlsRows(
  rows: readonly TlsFingerprintRow[],
  scope: SecurityTlsScope,
  query: string,
): TlsFingerprintRow[] {
  const needle = query.trim().toLocaleLowerCase();
  return [...rows]
    .filter((row) => {
      if (!needle) return true;
      return [row.scope, row.ja3, row.ja3_raw, row.ja4, row.ja4_raw]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase().includes(needle));
    })
    .sort((a, b) => b.total - a.total || b.last_seen_epoch_secs - a.last_seen_epoch_secs)
    .map((row) => ({ ...row, scope: scope === "by_fingerprint" ? undefined : row.scope }));
}
