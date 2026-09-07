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
