import type { LogSourceDiagnostic } from "../lib/api/generated/types.gen";

const REASONS = new Set([
  "file_missing", "permission_denied", "command_missing", "target_missing",
  "daemon_unavailable", "source_timeout", "read_failed", "command_failed",
]);

export function logSourceDiagnostic(value: unknown): LogSourceDiagnostic | undefined {
  if (!value || typeof value !== "object") return undefined;
  const diagnostic = value as {
    code?: unknown; message?: unknown; source?: unknown; service?: unknown;
    reason?: unknown; target?: unknown; exit_code?: unknown;
  };
  if (diagnostic.code !== "log_source_error" || typeof diagnostic.message !== "string"
    || typeof diagnostic.source !== "string" || (diagnostic.service !== "telemt" && diagnostic.service !== "panel")
    || typeof diagnostic.reason !== "string" || !REASONS.has(diagnostic.reason)
    || (diagnostic.target !== undefined && typeof diagnostic.target !== "string")
    || (diagnostic.exit_code !== undefined && (typeof diagnostic.exit_code !== "number" || !Number.isInteger(diagnostic.exit_code)))) return undefined;
  return diagnostic as LogSourceDiagnostic;
}
