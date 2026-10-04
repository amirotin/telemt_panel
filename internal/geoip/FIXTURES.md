# GeoIP test fixtures

fixture_test.go embeds gzip-compressed copies of these synthetic MaxMind test
databases:

- GeoIP2-Country-Test.mmdb - SHA-256 b37601903448683d241af52893c8cbf0fed461e0cdebe0bfaca01891fdeb6db9
- GeoLite2-ASN-Test.mmdb - SHA-256 75901b98ed6e58d3bd41af9985044b747a7ec0be1369f930c24f5e044427181a
- GeoIP2-City-Test.mmdb - SHA-256 ed972738e4e03a3e56e12041a6af4d91592249d110f7e4a647e5f2fa0e639c09

Source: https://github.com/maxmind/MaxMind-DB/tree/main/test-data, retrieved
2026-09-07. The upstream repository describes these as fake GeoIP2 example
data. It distributes the software and test data under Apache-2.0 or MIT, at
the recipient's option; see upstream LICENSE-APACHE and LICENSE-MIT.

Tests decode these local strings into temporary files. They never download a
database or contact a GeoIP service.

`schema_fixture_test.go` contains two additional synthetic Country databases,
created locally with the official `github.com/maxmind/mmdbwriter v1.2.0` writer
(Apache-2.0). They contain only the invented network `81.2.69.0/24` and these
records, respectively:

- Wrong schema: `{"country": uint32(7)}`. SHA-256
  `f535c3e6b7246bd52e770afd23a8ead317b213a260327795d5e880734c801684`.
- Optional fields: `{"country": {"iso_code": "GB"}}`. SHA-256
  `65caa010ed78e119ffe24eb74f9a6cee836a54d991544488e94f869cbd45e348`.

Reproduction options: `BuildEpoch: 1725000000`,
`DatabaseType: "GeoIP2-Country-Test"`, `IPVersion: 4`,
`Languages: []string{"en", "ru"}`,
`Description: map[string]string{"en": "Synthetic Telemt schema fixture"}`.
Create the tree with `mmdbwriter.New`, insert the network and record using
`mmdbtype.Map`/`String`/`Uint32`, then `WriteTo` a buffer and gzip/base64 encode it.
These fixtures contain no downloaded geolocation data and add no runtime or
test module dependency on the writer.

`location_fixture_test.go` adds eight synthetic City databases generated with
the same writer and options, using `DatabaseType: "GeoIP2-City-Test"` and
description `"Synthetic Telemt location fixture"`. Each contains the same
invented network, country code GB and city geoname_id 2643743. Location variants
cover explicit (0,0), absent/one-sided coordinates, out-of-range coordinates,
and incorrect latitude/radius types. The explicit-zero record uses radius
65535; absent radius remains optional. SHA-256 of uncompressed databases:

| Variant | SHA-256 |
| --- | --- |
| absent | c357961c58262d0d2b15d3d24e18adafa5f46f3b83e95f32824b988df4a112b6 |
| latitude-only | cbbcca3ebe6ee8a9b362637ffba25c46eae7aea110dcda02cfdd0e615313463e |
| longitude-only | e85a9d0cebf3bbee4bf3c94d27f4a2ef70cdf6d539dfae7b7d05f117185b83e4 |
| zero | 3bfe2d899c36f30ed298d0b4a18bca75a938fc0421ebaa367eca0e95dbdc2ca7 |
| bad-latitude | 22b0d14d50efbe27daa023d8e8cbf450be586dae23d43f728e06fc53dfcc548a |
| bad-longitude | 39efa3d1f3784a6f963bc9b67fbb1c9ce362532f19912c4707b3ee03499de5ff |
| bad-type | 5eb61cf8a0df5ea4830b1899d5ac216c0d82b94889667b550e9c8394bc7d794c |
| bad-radius | 81556313ca1a589062f6b856a37ad215aa1a2fc46c2bcdaf807ebdcfcd00889c |

For an optional measurement against real local files (not committed here), run:

```sh
GEOIP_BENCH_COUNTRY=/path/to/GeoLite2-Country.mmdb \
GEOIP_BENCH_ASN=/path/to/GeoLite2-ASN.mmdb \
GEOIP_BENCH_CITY=/path/to/GeoLite2-City.mmdb \
go test -run '^$' -bench BenchmarkRecordSchema -benchtime=1x ./internal/geoip
```

The benchmark reports network count, distinct record count, schema-validation
time and allocations. It does not download files or measure the panel's full
startup time. An unset path skips that database kind. Every distinct record is
checked; offsets are deduplicated only within one reader, never across files
or database replacements. Structural MMDB verification remains unchanged.
