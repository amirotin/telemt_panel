import { describe, expect, it } from "vitest";
import { en } from "../../i18n/en";
import { ru } from "../../i18n/ru";
import type { FieldCatalog } from "./fieldCatalog";
import {
  counterFamilyFor,
  describeField,
  lookupField,
  TLS_FINGERPRINTS_ENDPOINT,
} from "./fieldCatalog";

// A tiny catalog whose entries collide on purpose at every one of §8.2's
// five steps, so the priority is asserted rather than assumed.
const catalog: FieldCatalog = {
  entries: [
    { path: "writers.*.rtt_ema_ms", descriptionKey: "me.writers.rtt_ema_ms" },
    { path: "writers[0].rtt_ema_ms", descriptionKey: "dc.rtt_ms" },
    { path: "*.rtt_ema_ms", descriptionKey: "dc.load" },
  ],
  byEndpoint: {
    "/api/telemt/zero": [
      { path: "writers.*.rtt_ema_ms", descriptionKey: "dc.load" },
      { path: "core.custom_signal", descriptionKey: "dc.load" },
    ],
  },
};

describe("field catalog lookup order (spec §8.2, amended by ruling R9)", () => {
  it("1. an exact path beats every wildcard", () => {
    const result = lookupField("writers[0].rtt_ema_ms", { catalog });
    expect(result.source).toBe("exact");
    expect(result.entry?.descriptionKey).toBe("dc.rtt_ms");
  });

  it("2. a wildcard matches where no exact entry exists", () => {
    const result = lookupField("writers[7].rtt_ema_ms", { catalog });
    expect(result.source).toBe("wildcard");
    expect(result.entry?.descriptionKey).toBe("me.writers.rtt_ema_ms");
  });

  it("2. the more literal wildcard wins over the more wildcarded one", () => {
    // Both `writers.*.rtt_ema_ms` and `*.rtt_ema_ms` match — insertion
    // order must not decide which sentence a reader sees.
    expect(lookupField("writers[3].rtt_ema_ms", { catalog }).entry?.path).toBe(
      "writers.*.rtt_ema_ms",
    );
  });

  it("1. an endpoint-scoped rule beats BOTH global steps (ruling R9)", () => {
    // Most specific wins: a rule written FOR one endpoint outranks a
    // catalog-wide pattern, which is the reverse of the spec's own §8.2
    // ordering and the reason R9 was recorded.
    const result = lookupField("writers[7].rtt_ema_ms", {
      catalog,
      endpoint: "/api/telemt/zero",
    });
    expect(result.source).toBe("endpoint");
    expect(result.entry?.descriptionKey).toBe("dc.load");
    // …and it outranks a global EXACT entry too (M4 task 8b). A bare field
    // name belongs to whichever domain is on screen: `reason`, `state`,
    // `host`, `user` and `attempt` are all names two Telemt payloads use for
    // different things, so a global exact winning here put the DC sentence
    // on a WEB row.
    expect(
      lookupField("writers[0].rtt_ema_ms", { catalog, endpoint: "/api/telemt/zero" }).source,
    ).toBe("endpoint");
    // …while with no endpoint in play both global steps answer as before.
    expect(lookupField("writers[0].rtt_ema_ms", { catalog }).source).toBe("exact");
    expect(lookupField("writers[7].rtt_ema_ms", { catalog }).source).toBe("wildcard");
  });

  it("3. an endpoint-scoped entry fills a gap the global catalog leaves", () => {
    const result = lookupField("core.custom_signal", { catalog, endpoint: "/api/telemt/zero" });
    expect(result.source).toBe("endpoint");
    expect(lookupField("core.custom_signal", { catalog }).source).toBe("fallback");
  });

  it("4. a known counters family answers before the neutral fallback", () => {
    const result = lookupField("core.handshake_timeouts_total", { catalog });
    expect(result.source).toBe("family");
    expect(result.family).toBe("errorsTotal");
  });

  it("4. a more specific family wins: errors_total is not merely a total", () => {
    expect(counterFamilyFor("upstream.connect_errors_total")?.id).toBe("errorsTotal");
    expect(counterFamilyFor("upstream.connect_total")?.id).toBe("total");
    expect(counterFamilyFor("pool.wait_ms")?.id).toBe("milliseconds");
    expect(counterFamilyFor("pool.sent_octets")?.id).toBe("bytes");
    expect(counterFamilyFor("dcs[0].coverage_pct")?.id).toBe("percent");
  });

  it("5. an unknown field gets the neutral text and no invented meaning", () => {
    const result = lookupField("something.nobody.has.seen", { catalog });
    expect(result.source).toBe("fallback");
    expect(result.entry).toBeNull();
    expect(describeField("something.nobody.has.seen", ru, { catalog }).description).toBe(
      ru.details.fields.fallback,
    );
  });

  it("memoizes per catalog and per endpoint", () => {
    const first = lookupField("writers[9].rtt_ema_ms", { catalog });
    const second = lookupField("writers[9].rtt_ema_ms", { catalog });
    expect(second).toBe(first);
    // A different endpoint is a different cache key, not a stale hit.
    expect(lookupField("core.custom_signal", { catalog, endpoint: "/api/telemt/zero" }).source).toBe(
      "endpoint",
    );
  });
});

describe("describeField (spec §8)", () => {
  it("resolves the description in the reader's language", () => {
    const rus = describeField("dcs[0].rtt_ms", ru).description;
    const eng = describeField("dcs[0].rtt_ms", en).description;
    expect(rus).toBe(ru.details.fields.descriptions["dc.rtt_ms"]);
    expect(eng).toBe(en.details.fields.descriptions["dc.rtt_ms"]);
    expect(rus).not.toBe(eng);
  });

  it("gives the payload-rooted and entity-rooted spellings one sentence", () => {
    expect(describeField("dcs[0].coverage_pct", ru).description).toBe(
      describeField("coverage_pct", ru).description,
    );
  });

  it("carries the unit and formatter the catalog pins to a field", () => {
    expect(describeField("dcs[0].coverage_pct", ru).unit).toBe("percent");
    expect(describeField("dcs[0].floor_capped", ru).format).toBe("boolean");
    expect(describeField("dcs[0].endpoints[0]", ru).format).toBe("address");
  });

  it("carries nullMeaning and zeroMeaning where §13.1 needs them", () => {
    expect(describeField("dcs[0].rtt_ms", ru).nullMeaning).toBe(
      ru.details.fields.nullMeanings["dc.rtt_ms"],
    );
    expect(describeField("dcs[0].alive_writers", ru).zeroMeaning).toBe(
      ru.details.fields.zeroMeanings["dc.alive_writers"],
    );
    // A field with no known null meaning must NOT borrow another's.
    expect(describeField("dcs[0].load", ru).nullMeaning).toBeUndefined();
  });

  it("hands a counters-family field its family sentence and formatting", () => {
    // A counter nobody has described — which since Task 7 means one Telemt's
    // own API reference does not document either, since every documented
    // zero/all counter now has a hand-written sentence.
    const field = describeField("core.a_future_handshake_timeouts_total", ru);
    expect(field.description).toBe(ru.details.fields.families.errorsTotal);
    expect(field.format).toBe("integer");
  });
});

// The TLS domain is the first ENDPOINT-SCOPED one (R9): its record fields
// are called `total`, `limit`, `capacity` and `scope`, words other Telemt
// payloads use for other things. Scoping keeps one page's meaning off
// another page's rows — and is the mechanism the Ranking surface reads
// through.
describe("field catalog: TLS is endpoint-scoped (R9)", () => {
  const tls = { endpoint: TLS_FINGERPRINTS_ENDPOINT };

  it("describes a ranking record's fields under its endpoint", () => {
    expect(lookupField("by_fingerprint[0].ja4", tls).source).toBe("endpoint");
    expect(describeField("by_fingerprint[0].ja4", ru, tls).description).toBe(
      ru.details.fields.descriptions["tls.ja4"],
    );
    // All four groups share the one sentence.
    for (const scope of ["by_fingerprint", "by_ip", "by_cidr", "by_user"]) {
      expect(describeField(`${scope}[3].total`, ru, tls).description).toBe(
        ru.details.fields.descriptions["tls.total"],
      );
    }
  });

  it("reads a last-seen stamp as a MOMENT, not as a duration in seconds", () => {
    const field = describeField("by_fingerprint[0].last_seen_epoch_secs", ru, tls);
    expect(field.unit).toBe("timestamp");
    expect(field.description).not.toBe(ru.details.fields.families.seconds);
  });

  it("says nothing about `total` or `limit` on a page that is not the TLS one", () => {
    // Without the endpoint scope the same generic key falls through to the
    // counters family or the neutral fallback — which is the whole point.
    expect(lookupField("by_fingerprint[0].ja4").source).toBe("fallback");
    expect(lookupField("limit").source).toBe("fallback");
  });
});
