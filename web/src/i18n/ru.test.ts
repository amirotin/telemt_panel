import { describe, expect, it } from "vitest";
import { errorMessage, errorMessages } from "./ru";

// Every {code} api/openapi.yaml's Error schema documents (its `code`
// property description — grepped from every panel WriteError call site
// plus every Telemt *APIError code passed through verbatim) must have a
// human message here. This list is maintained by hand in step with that
// prose description (it isn't a structured enum in the YAML, so there's
// nothing machine-parseable to diff against) — see task-4-report.md for how
// it was extracted.
const OPENAPI_ERROR_CODES = [
  "bad_request",
  "invalid_credentials",
  "rate_limited",
  "session_expired",
  "csrf_rejected",
  "internal_error",
  "not_found",
  "telemt_unreachable",
  "capability_absent",
  "capability_unavailable",
  "manual_restart_required",
  "update_locked",
  "sublink_unavailable",
  "log_tail_unavailable",
  "log_stream_unavailable",
  "log_source_error",
  "totp_required",
  "telemt_auth_failed",
  "user_exists",
  "last_user_forbidden",
  "read_only",
  "revision_conflict",
  "reload_in_progress",
  "reload_not_found",
  "ambiguous_listeners",
  "bad_request",
  "access_not_editable",
  "section_not_editable",
  "field_not_editable",
  "unauthorized",
  "forbidden",
  "method_not_allowed",
  "config_patch_not_atomic",
  "payload_too_large",
  "api_disabled",
  "maestro_unavailable",
];

describe("errorMessages completeness", () => {
  it("has a non-empty Russian message for every documented openapi error code", () => {
    for (const code of OPENAPI_ERROR_CODES) {
      expect(errorMessages[code], `missing message for code "${code}"`).toBeTruthy();
    }
  });

  it("falls back to the default message for an unknown code", () => {
    expect(errorMessage("some_future_code_not_yet_known")).toBe(errorMessages["default"]);
  });

  it("returns the mapped message for a known code", () => {
    expect(errorMessage("rate_limited")).toBe(errorMessages["rate_limited"]);
  });
});
