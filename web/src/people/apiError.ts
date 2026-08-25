import { errorMessage, errorMessages } from "../i18n/ru";

// apiErrorMessage mirrors routes/login.tsx's loginErrorMessage: every
// generated *Error type here is the same openapi `Error` schema (a required
// non-empty `code`), so the absence of a well-formed `code` means fetch
// itself never got a response at all (offline/DNS/CORS), not a documented
// envelope error.
export function apiErrorMessage(err: { code?: unknown } | undefined): string {
  if (!err || typeof err.code !== "string") return errorMessages["network"];
  return errorMessage(err.code);
}

// apiErrorCode extracts a well-formed envelope `code` from a query error of
// unknown shape — for endpoints whose generated error type is TanStack
// Query's generic DefaultError (e.g. getHostOptions, which documents no
// error responses in openapi.yaml) rather than a typed openapi Error, so
// there's no `.code` to read without narrowing first. Feeds AsyncState's
// `errorCode` prop, which does its own errorMessage() lookup — this only
// narrows, it doesn't localize (see apiErrorMessage above for that).
export function apiErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  return undefined;
}
