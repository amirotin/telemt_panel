import { describe, expect, it } from "vitest";
import { ru } from "../i18n/ru";
import { en } from "../i18n/en";
import { errorMessage } from "../i18n/messages";
import { apiErrorMessage } from "./apiError";

describe("Telemt error explanations", () => {
  it("explains config ownership instead of claiming the proxy is stopped", () => {
    const message = apiErrorMessage({ code: "telemt_config_permission_denied" }, ru);
    expect(message).toMatch(/владельц/);
    expect(message).toMatch(/конфигурац/);
    expect(message).not.toContain("прокси запущен");
    expect(errorMessage(en, "telemt_config_permission_denied")).toMatch(/owner/);
  });

  it.each([
    "telemt_config_read_only", "telemt_config_storage_full", "telemt_config_write_failed", "telemt_config_read_failed",
    "telemt_api_error", "telemt_timeout", "telemt_dns_failed", "telemt_tls_failed", "telemt_invalid_response",
  ])("explains %s in both languages", (code) => {
    for (const dict of [ru, en]) {
      const message = errorMessage(dict, code);
      expect(message).not.toBe(dict.errors.default);
      expect(message).not.toBe(dict.errors.telemt_unreachable);
    }
  });

  it("keeps an upstream status, code and request ID visible in the user action", () => {
    const message = apiErrorMessage({ code: "telemt_config_permission_denied", message: "HTTP 500 · internal_error · #42" }, ru);
    expect(message).toContain("HTTP 500 · internal_error · #42");
    expect(message).toMatch(/владельц/);
  });

  it.each([
    "failed to write config: secret=UPSTREAM_SECRET", "HTTP 500\nAuthorization: UPSTREAM_SECRET",
    "HTTP 500 · <script>UPSTREAM_SECRET</script>", `HTTP 500 · ${"a".repeat(512)}`,
  ])("does not show arbitrary upstream text", (message) => {
    const text = apiErrorMessage({ code: "telemt_api_error", message }, ru);
    expect(text).not.toContain("UPSTREAM_SECRET");
    expect(text).not.toContain(message);
  });

  it("preserves recovery guidance for an unconfirmed write", () => {
    const text = apiErrorMessage({ code: "telemt_config_outcome_unknown" }, ru);
    expect(text).toMatch(/могли сохраниться/);
    expect(text).toMatch(/перед повтором/);
  });

  it.each(["\n", "\r", "\u2028", "\u2029"])("rejects trailing line terminators in metadata", (terminator) => {
    const base = apiErrorMessage({ code: "telemt_api_error" }, ru);
    expect(apiErrorMessage({ code: "telemt_api_error", message: `HTTP 500${terminator}` }, ru)).toBe(base);
  });
});
