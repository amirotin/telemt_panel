import { describe, expect, it } from "vitest";
import { ru } from "../i18n";
import { describeField, formatValue } from "../pulse/details-builder";
import { devMePayload } from "./detailsDefinitions";
import { meQuality } from "../pulse/details-builder/__fixtures__";

// The dev route is what the screenshot checkpoint (§27.1) is judged on, so a
// visibly wrong value there is a defect in the evidence. `_epoch_secs` is an
// absolute moment; without a catalog entry the `_secs` counters family reads
// it as a duration and prints "20 324 дн." next to a healthy family.
//
// Until M4 task 7 these two entries lived in a harness-only `devCatalog`
// override, because the ME domain had no catalog entries of its own. The
// domain now ships in DEFAULT_FIELD_CATALOG, so the harness renders the same
// descriptions the real page does — and these tests assert exactly that.

const NOW = 1_756_000_125_000;

describe("dev harness field descriptions", () => {
  it("renders an in-array epoch timestamp as a moment, not as a duration", () => {
    const path = "quality.family_states[0].state_since_epoch_secs";
    const field = describeField(path, ru);
    expect(field.unit).toBe("timestamp");

    const value = meQuality.family_states[0]?.state_since_epoch_secs;
    const formatted = formatValue(value, ru, {
      nowMs: NOW,
      ...(field.unit !== undefined ? { unit: field.unit } : {}),
    });
    // 1755999441 is ~9 minutes before the fixed clock — an age, and never
    // the twenty thousand days the seconds family produced.
    expect(formatted.text).toContain("назад");
    expect(formatted.text).not.toContain("дн.");
  });

  it("stops describing a moment as a duration", () => {
    const field = describeField("quality.drain_gate.updated_at_epoch_secs", ru);
    expect(field.unit).toBe("timestamp");
    expect(field.description).not.toBe(ru.details.fields.families.seconds);
  });

  it("feeds the harness the same composed payload the real ME page reads", () => {
    // The harness renders the PRODUCTION definition now, so its payload has
    // to be the production shape — a drifted fixture would make every ME
    // screenshot evidence for a page that does not exist.
    expect(devMePayload.writers).toBeDefined();
    expect(devMePayload.quality).toBe(meQuality);
    expect(devMePayload.me_runtime).toBeDefined();
  });
});
