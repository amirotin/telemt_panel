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
