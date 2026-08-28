import { describe, expect, it } from "vitest";
import { buildConfigPatch, getSectionField, setSectionField } from "./configPatch.helpers";

describe("buildConfigPatch", () => {
  it("returns an empty object when nothing changed", () => {
    const sections = { general: { use_middle_proxy: true, ad_tag: "abc" } };
    expect(buildConfigPatch(sections, sections)).toEqual({});
  });

  it("includes only the changed leaf key", () => {
    const original = { general: { use_middle_proxy: true, ad_tag: "abc" } };
    const edited = { general: { use_middle_proxy: true, ad_tag: "def" } };
    expect(buildConfigPatch(original, edited)).toEqual({ general: { ad_tag: "def" } });
  });

  it("omits an unchanged sibling key next to a changed one", () => {
    const original = { timeouts: { client_handshake: 15, tg_connect: 10 } };
    const edited = { timeouts: { client_handshake: 20, tg_connect: 10 } };
    expect(buildConfigPatch(original, edited)).toEqual({ timeouts: { client_handshake: 20 } });
  });

  it("recurses into nested tables (deep-merge semantics)", () => {
    const original = { server: { listeners: { a: { port: 443 }, b: { port: 80 } } } };
    const edited = { server: { listeners: { a: { port: 8443 }, b: { port: 80 } } } };
    expect(buildConfigPatch(original, edited)).toEqual({ server: { listeners: { a: { port: 8443 } } } });
  });

  it("sends an array wholesale when it differs, never a partial merge", () => {
    const original = { upstreams: { list: [1, 2, 3] } };
    const edited = { upstreams: { list: [1, 2, 4] } };
    expect(buildConfigPatch(original, edited)).toEqual({ upstreams: { list: [1, 2, 4] } });
  });

  it("omits an unchanged array entirely", () => {
    const original = { upstreams: { list: [1, 2, 3] } };
    const edited = { upstreams: { list: [1, 2, 3] } };
    expect(buildConfigPatch(original, edited)).toEqual({});
  });

  it("emits a brand-new section in full", () => {
    const original = {};
    const edited = { general: { ad_tag: "abc" } };
    expect(buildConfigPatch(original, edited)).toEqual({ general: { ad_tag: "abc" } });
  });

  it("keeps integers as integers, never round-tripped through a string", () => {
    const original = { timeouts: { client_handshake: 15 } };
    const edited = { timeouts: { client_handshake: 9007199254740 } };
    const patch = buildConfigPatch(original, edited);
    expect(patch).toEqual({ timeouts: { client_handshake: 9007199254740 } });
    expect(typeof (patch["timeouts"] as Record<string, unknown>)["client_handshake"]).toBe("number");
  });

  it("never emits a null for a key removed from edited (no delete semantics)", () => {
    const original = { general: { use_middle_proxy: true, ad_tag: "abc" } };
    const edited = { general: { use_middle_proxy: true } };
    expect(buildConfigPatch(original, edited)).toEqual({});
  });

  it("neither sends nor drops an untouched section the panel knows nothing about", () => {
    // Editing `general` while `web` (Telemt 3.5.3+) sits untouched in the
    // config: the patch must carry only `general` — sending `web` back
    // would re-assert a section the admin never edited, and losing it from
    // the working copy would silently strip it from the editor.
    const web = { enabled: true, limits: { max_sessions_global: 128 } };
    const original = { general: { ad_tag: "abc" }, web };
    const edited = { general: { ad_tag: "def" }, web };
    expect(buildConfigPatch(original, edited)).toEqual({ general: { ad_tag: "def" } });
  });

  it("patches only the changed leaf inside an unknown section", () => {
    const original = { web: { enabled: true, limits: { max_sessions_global: 128 } } };
    const edited = { web: { enabled: true, limits: { max_sessions_global: 256 } } };
    expect(buildConfigPatch(original, edited)).toEqual({ web: { limits: { max_sessions_global: 256 } } });
  });

  it("ignores a section present only in original (never diffed, never deleted)", () => {
    const original = { general: { ad_tag: "abc" }, timeouts: { client_handshake: 15 } };
    const edited = { general: { ad_tag: "abc" } };
    expect(buildConfigPatch(original, edited)).toEqual({});
  });
});

describe("getSectionField / setSectionField", () => {
  it("reads undefined for a missing section or key", () => {
    expect(getSectionField({}, "general", "ad_tag")).toBeUndefined();
    expect(getSectionField({ general: { ad_tag: "x" } }, "general", "other")).toBeUndefined();
  });

  it("reads an existing value", () => {
    expect(getSectionField({ general: { ad_tag: "x" } }, "general", "ad_tag")).toBe("x");
  });

  it("writes a value into a missing section without mutating the input", () => {
    const sections = {};
    const next = setSectionField(sections, "general", "ad_tag", "x");
    expect(sections).toEqual({});
    expect(next).toEqual({ general: { ad_tag: "x" } });
  });

  it("writes a value alongside existing keys in the same section", () => {
    const sections = { general: { use_middle_proxy: true } };
    const next = setSectionField(sections, "general", "ad_tag", "x");
    expect(next).toEqual({ general: { use_middle_proxy: true, ad_tag: "x" } });
  });
});
