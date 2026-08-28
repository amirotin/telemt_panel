import { describe, expect, it } from "vitest";
import { orderSections, orderedSections } from "./orderSections.helpers";

describe("orderSections", () => {
  it("puts the known sections in their fixed order regardless of input order", () => {
    const keys = ["web", "server", "general", "censorship", "timeouts", "dc_overrides", "upstreams"];
    expect(orderSections(keys)).toEqual([
      "general",
      "timeouts",
      "censorship",
      "upstreams",
      "dc_overrides",
      "server",
      "web",
    ]);
  });

  it("omits a known section that is absent from the config", () => {
    expect(orderSections(["web", "general"])).toEqual(["general", "web"]);
  });

  it("keeps unknown sections, sorted alphabetically, after the known ones", () => {
    const keys = ["zeta_section", "general", "future_section", "web"];
    expect(orderSections(keys)).toEqual(["general", "web", "future_section", "zeta_section"]);
  });

  it("returns an empty list for an empty config", () => {
    expect(orderSections([])).toEqual([]);
  });
});

describe("orderedSections", () => {
  it("rebuilds the object with ordered keys and identical values", () => {
    const web = { enabled: true, limits: { max_sessions_global: 128 } };
    const sections = { web, future_section: { n: 1 }, general: { log_level: "info" } };

    const ordered = orderedSections(sections);

    expect(Object.keys(ordered)).toEqual(["general", "web", "future_section"]);
    // Section bodies are carried over by reference — this helper decides
    // display order only, it must never clone or rewrite config values.
    expect(ordered["web"]).toBe(web);
    expect(ordered).toEqual(sections);
  });

  it("preserves a section whose value is not an object", () => {
    const sections = { general: { log_level: "info" }, censorship: null };
    expect(orderedSections(sections)).toEqual(sections);
    expect(Object.keys(orderedSections(sections))).toEqual(["general", "censorship"]);
  });
});
