import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { errorMessage, errorMessages } from "./ru";

// Parses api/openapi.yaml directly (js-yaml — already a devDependency for
// scripts/filter-openapi.mjs, so this adds zero new npm packages; see
// task-4-report.md's "Fix round 1" section) rather than hand-maintaining a
// second copy of the code list here, which is exactly the drift risk this
// replaces: api/openapi.yaml's Error.code is now a proper `enum:` (docs(api)
// change, Fix round 1 item 5), so this test is the single source of truth
// walking the real contract instead of a string a human has to remember to
// update in lockstep.
function documentedErrorCodes(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const openapiPath = path.join(here, "..", "..", "..", "api", "openapi.yaml");
  const doc = yaml.load(readFileSync(openapiPath, "utf8"));
  const codes = (
    doc as {
      components?: { schemas?: { Error?: { properties?: { code?: { enum?: unknown } } } } };
    }
  ).components?.schemas?.Error?.properties?.code?.enum;
  if (!Array.isArray(codes) || codes.length === 0) {
    throw new Error("openapi.yaml: components.schemas.Error.properties.code.enum is missing/empty");
  }
  return codes.map((c) => {
    if (typeof c !== "string") throw new Error(`non-string error code in openapi.yaml enum: ${String(c)}`);
    return c;
  });
}

describe("errorMessages completeness", () => {
  it("has a non-empty Russian message for every code in openapi.yaml's Error.code enum", () => {
    for (const code of documentedErrorCodes()) {
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
