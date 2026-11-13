import { errorMessage, type Dict } from "../i18n";

// apiErrorMessage mirrors routes/login.tsx's loginErrorMessage: every
// generated *Error type here is the same openapi `Error` schema (a required
// non-empty `code`), so the absence of a well-formed `code` means fetch
// itself never got a response at all (offline/DNS/CORS), not a documented
// envelope error.
export function apiErrorMessage(err: unknown, s: Dict): string {
  const code = apiErrorCode(err);
  if (!code) return errorMessage(s, "network");
  const detail = err && typeof err === "object" && "message" in err ? err.message : undefined;
  return errorMessage(s, code, detail);
}

// apiErrorCode extracts a well-formed envelope `code` from a query error of
// unknown shape — for endpoints whose generated error type is TanStack
// Query's generic DefaultError (e.g. getHostOptions, which documents no
// error responses in openapi.yaml) rather than a typed openapi Error, so
// there's no `.code` to read without narrowing first. Feeds AsyncState's
// `errorCode` prop, which does its own errorMessage(s) lookup — this only
// narrows, it doesn't localize (see apiErrorMessage above for that).
export function apiErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  return undefined;
}
