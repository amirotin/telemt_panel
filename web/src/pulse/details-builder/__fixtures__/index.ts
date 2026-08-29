// Production-size Telemt fixtures for the Details-page builder.
//
// Every value here is sized and shaped from TELEMT_LIVE_API_DATA.md — a
// snapshot of three live VPS — rather than from a hand-written mock: 12 DCs,
// 46 ME writers, 16 initialization components, 4×50 TLS records, 115
// counter rows, 50 events, 13 configured STUN servers. The point of the M4
// wave is that the current renderers turn exactly these payloads into
// 255/1091/2003 KV rows, so anything built against a three-element mock
// proves nothing.
//
// Rules for this directory:
//   * deterministic — seeded generators only, never Math.random or
//     Date.now, so a failing render test reproduces byte-for-byte;
//   * typed against realtime/topics.ts (SSE payloads) and the generated
//     client (REST payloads), so a wire-shape change breaks the build here
//     first;
//   * sanitized — documentation-range addresses (RFC 5737/3849), generic
//     usernames, synthesized fingerprints; no real endpoint, IP or secret.
//
// The cardinalities are pinned by fixtures.test.ts: it is the inventory
// this wave's later tasks size their layouts against.
export * from "./seed";
export * from "./stats";
export * from "./runtime";
export * from "./security";
export * from "./topics";
export * from "./edges";
export * from "./web";
