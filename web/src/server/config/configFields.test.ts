import { describe, expect, it } from "vitest";
import {
  CONFIG_FIELDS,
  QUICK_SETTINGS_SECTIONS,
  isQuickSettingsSectionShown,
  unknownKeysInSection,
} from "./configFields";
import { en, ru } from "../../i18n";

describe("unknownKeysInSection", () => {
  it("returns nothing when every key is known", () => {
    expect(unknownKeysInSection("general", { use_middle_proxy: true, ad_tag: "x" })).toEqual([]);
  });

  it("lists a key not in the catalog", () => {
    expect(unknownKeysInSection("general", { use_middle_proxy: true, mystery_field: 1 })).toEqual([
      "mystery_field",
    ]);
  });

  it("returns nothing for a non-object section value", () => {
    expect(unknownKeysInSection("general", undefined)).toEqual([]);
    expect(unknownKeysInSection("general", null)).toEqual([]);
    expect(unknownKeysInSection("general", [1, 2])).toEqual([]);
  });

  it("treats a section with no catalog entries as fully unknown", () => {
    expect(unknownKeysInSection("server", { listeners: [] })).toEqual(["listeners"]);
  });
});

// The `web` section (M4 task 8b): ONE key, and a card that only appears when
// Telemt actually sends the section.
describe("the WEB quick setting", () => {
  it("offers exactly one key — the switch, not the whole [web] structure", () => {
    const web = CONFIG_FIELDS.filter((f) => f.section === "web");
    expect(web).toEqual([{ section: "web", key: "enabled", kind: "bool" }]);
    expect(QUICK_SETTINGS_SECTIONS).toContain("web");
    // Everything else in [web] — vhosts, profiles, carriers, limits,
    // timeouts — stays read-only in the form and editable in the raw editor.
    expect(
      unknownKeysInSection("web", { enabled: true, carrier: "https-lanes", limits: {} }),
    ).toEqual(["carrier", "limits"]);
  });

  it("renders only when Telemt sends the section", () => {
    // `web` became editable in Telemt 3.5.3. An older build omits it, and a
    // toggle there would build a PATCH the proxy rejects.
    expect(isQuickSettingsSectionShown("web", { web: { enabled: false } })).toBe(true);
    expect(isQuickSettingsSectionShown("web", {})).toBe(false);
    expect(isQuickSettingsSectionShown("web", { web: null })).toBe(false);
    // The three original sections keep rendering unconditionally.
    for (const section of ["general", "timeouts", "censorship"]) {
      expect(isQuickSettingsSectionShown(section, {}), section).toBe(true);
    }
  });

  it("warns, in both languages, that turning WEB off leaves live sessions alone", () => {
    // The consequence a label cannot carry: `web.enabled = false` stops
    // ISSUANCE; already-connected clients keep working until they are
    // closed explicitly (Telemt docs, WEB_PROXY §Operational notes).
    expect(ru.server.config.sectionNotes.web).toContain("не закрывает живые сессии");
    expect(en.server.config.sectionNotes.web).toContain("does not close live sessions");
  });
});
