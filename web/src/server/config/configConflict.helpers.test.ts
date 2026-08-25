import { describe, expect, it } from "vitest";
import { diffChangedSectionKeys } from "./configConflict.helpers";

describe("diffChangedSectionKeys", () => {
  it("returns nothing for identical snapshots", () => {
    const s = { general: { ad_tag: "abc" } };
    expect(diffChangedSectionKeys(s, s)).toEqual([]);
  });

  it("reports a single changed leaf as one dotted path", () => {
    const before = { general: { ad_tag: "abc" } };
    const after = { general: { ad_tag: "def" } };
    expect(diffChangedSectionKeys(before, after)).toEqual(["general.ad_tag"]);
  });

  it("reports multiple changed leaves across sections, sorted", () => {
    const before = { general: { ad_tag: "abc" }, timeouts: { client_handshake: 15 } };
    const after = { general: { ad_tag: "def" }, timeouts: { client_handshake: 20 } };
    expect(diffChangedSectionKeys(before, after)).toEqual(["general.ad_tag", "timeouts.client_handshake"]);
  });

  it("reports a brand-new section as a path per leaf", () => {
    const before = {};
    const after = { general: { ad_tag: "abc" } };
    expect(diffChangedSectionKeys(before, after)).toEqual(["general.ad_tag"]);
  });

  it("recurses into nested tables", () => {
    const before = { server: { listeners: { a: { port: 443 } } } };
    const after = { server: { listeners: { a: { port: 8443 } } } };
    expect(diffChangedSectionKeys(before, after)).toEqual(["server.listeners.a.port"]);
  });

  it("ignores an unchanged sibling", () => {
    const before = { timeouts: { client_handshake: 15, tg_connect: 10 } };
    const after = { timeouts: { client_handshake: 20, tg_connect: 10 } };
    expect(diffChangedSectionKeys(before, after)).toEqual(["timeouts.client_handshake"]);
  });
});
