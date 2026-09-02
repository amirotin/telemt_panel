import { describe, expect, it } from "vitest";
import type { TelemtConfigCatalog } from "../../lib/api/generated/types.gen";
import { configChangeEntries, concreteToCatalogPath } from "./configChangePreview.helpers";

const catalog: TelemtConfigCatalog = {
  version: "3.5.5",
  source_commit: "test",
  documented_fields: 1,
  runtime_additions: [],
  groups: [],
  fields: [{
    path: "general.enabled",
    data_type: "bool",
    kind: "boolean",
    default_value: "true",
    doc_hot: true,
    apply: "runtime reload",
    tier: "normal",
    group: "routing",
    secret: false,
  }],
};

describe("config change preview", () => {
  it("reports scalar leaves but treats arrays as wholesale replacements", () => {
    const changes = configChangeEntries(
      { general: { enabled: true }, upstreams: [{ weight: 1 }] },
      { general: { enabled: false }, upstreams: [{ weight: 2 }] },
      catalog,
    );
    expect(changes.map((change) => [change.path, change.arrayReplacement])).toEqual([
      ["general.enabled", false],
      ["upstreams", true],
    ]);
  });

  it("normalizes record indexes to schema placeholders", () => {
    expect(concreteToCatalogPath("web.vhosts[2].profiles[0].user")).toBe("web.vhosts[].profiles[].user");
  });
});
