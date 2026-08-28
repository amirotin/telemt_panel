import { describe, expect, it } from "vitest";
import { rebaseEdits } from "./rebaseEdits";

describe("rebaseEdits", () => {
  it("reapplies a non-overlapping pending patch onto the fresh base with no overlap reported", () => {
    const freshBase = { general: { ad_tag: "server-changed" }, timeouts: { client_handshake: 15 } };
    const pendingPatch = { timeouts: { client_handshake: 30 } };
    const serverChangedKeys = ["general.ad_tag"];

    const { edited, overlapping } = rebaseEdits(freshBase, pendingPatch, serverChangedKeys);

    expect(overlapping).toEqual([]);
    expect(edited).toEqual({ general: { ad_tag: "server-changed" }, timeouts: { client_handshake: 30 } });
  });

  it("reports an overlapping key when the admin's edit and the server's change touch the same field", () => {
    const freshBase = { general: { ad_tag: "server-changed" } };
    const pendingPatch = { general: { ad_tag: "admin-changed" } };
    const serverChangedKeys = ["general.ad_tag"];

    const { edited, overlapping } = rebaseEdits(freshBase, pendingPatch, serverChangedKeys);

    expect(overlapping).toEqual(["general.ad_tag"]);
    // The merge still favors the admin's edit — the CALLER decides whether
    // to actually use this, gated behind a confirmation when overlapping.
    expect(edited).toEqual({ general: { ad_tag: "admin-changed" } });
  });

  it("detects overlap on a nested key", () => {
    const freshBase = { server: { listeners: { a: { port: 8080 } } } };
    const pendingPatch = { server: { listeners: { a: { port: 9090 } } } };
    const serverChangedKeys = ["server.listeners.a.port"];

    const { overlapping } = rebaseEdits(freshBase, pendingPatch, serverChangedKeys);
    expect(overlapping).toEqual(["server.listeners.a.port"]);
  });

  it("preserves sibling keys in the fresh base untouched by the pending patch", () => {
    const freshBase = { general: { ad_tag: "x", use_middle_proxy: true } };
    const pendingPatch = { general: { ad_tag: "y" } };

    const { edited } = rebaseEdits(freshBase, pendingPatch, []);
    expect(edited).toEqual({ general: { ad_tag: "y", use_middle_proxy: true } });
  });

  it("returns the fresh base unchanged for an empty pending patch", () => {
    const freshBase = { general: { ad_tag: "x" } };
    const { edited, overlapping } = rebaseEdits(freshBase, {}, ["general.ad_tag"]);
    expect(edited).toEqual(freshBase);
    expect(overlapping).toEqual([]);
  });

  it("reports multiple overlapping keys, sorted", () => {
    const freshBase = { general: { ad_tag: "a" }, timeouts: { client_handshake: 1 } };
    const pendingPatch = { general: { ad_tag: "b" }, timeouts: { client_handshake: 2 } };
    const serverChangedKeys = ["timeouts.client_handshake", "general.ad_tag"];

    const { overlapping } = rebaseEdits(freshBase, pendingPatch, serverChangedKeys);
    expect(overlapping).toEqual(["general.ad_tag", "timeouts.client_handshake"]);
  });

  it("carries an untouched section the panel knows nothing about through the merge", () => {
    // `web` (Telemt 3.5.3+) stands in for any section the panel only
    // passes through: a rebase driven by an edit elsewhere must neither
    // drop it nor rewrite it.
    const web = { enabled: true, limits: { max_sessions_global: 128 } };
    const freshBase = { general: { ad_tag: "server-changed" }, web, future_section: { n: 1 } };
    const pendingPatch = { general: { ad_tag: "admin-changed" } };

    const { edited } = rebaseEdits(freshBase, pendingPatch, []);

    expect(edited).toEqual({
      general: { ad_tag: "admin-changed" },
      web,
      future_section: { n: 1 },
    });
    expect(edited["web"]).toBe(web);
  });

  it("deep-merges into an unknown section without losing its sibling keys", () => {
    const freshBase = { web: { enabled: true, carrier: "https-lanes", limits: { max_sessions_global: 128 } } };
    const pendingPatch = { web: { limits: { max_sessions_global: 256 } } };

    const { edited } = rebaseEdits(freshBase, pendingPatch, []);

    expect(edited).toEqual({
      web: { enabled: true, carrier: "https-lanes", limits: { max_sessions_global: 256 } },
    });
  });

  it("replaces an array wholesale in the merge, not element-wise", () => {
    const freshBase = { upstreams: { list: [1, 2, 3] } };
    const pendingPatch = { upstreams: { list: [4, 5] } };
    const { edited } = rebaseEdits(freshBase, pendingPatch, []);
    expect(edited).toEqual({ upstreams: { list: [4, 5] } });
  });
});
