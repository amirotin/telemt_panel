import { describe, expect, it } from "vitest";
import { ru } from "../i18n";
import { describeField, formatValue } from "../pulse/details-builder";
import { devCatalog } from "./detailsDefinitions";
import { meQuality } from "../pulse/details-builder/__fixtures__";

// The dev route is what the screenshot checkpoint (§27.1) is judged on, so a
// visibly wrong value there is a defect in the evidence. `_epoch_secs` is an
// absolute moment; without a catalog entry the `_secs` counters family reads
// it as a duration and prints "20 324 дн." next to a healthy family.

const NOW = 1_756_000_125_000;

describe("dev field catalog", () => {
  it("renders an in-array epoch timestamp as a moment, not as a duration", () => {
    const path = "family_states[0].state_since_epoch_secs";
    const field = describeField(path, ru, { catalog: devCatalog });
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
});
