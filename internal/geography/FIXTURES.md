# Synthetic scale MMDB

`scale_fixture_test.go` embeds a gzip/base64 City MMDB produced with the
official `github.com/maxmind/mmdbwriter v1.2.0` (Apache-2.0) in an isolated
generator module. It contains only invented data, no downloaded geolocation
records or real observed accounts/addresses. Runtime/test Go dependencies are
unchanged.

Reproduction: IPv6 tree, `IncludeReservedNetworks: true`, build epoch
1725000000, database type `GeoIP2-City-Test`, languages en/ru, description
`Synthetic Telemt geography scale fixture, seed 20261004`. Insert individual
documentation addresses `2001:db8::<hex i>/128` for i=1..20000. Let
place=(i-1)%2000, city geoname_id=place+1, name in both languages
`Fixture city <place padded to 4 digits>`. Country is the first 100 sorted
alpha-2 keys of `web/src/geography/world-country-codes.json`, indexed by
place%100; country names are `Fixture <code>`. Latitude=place%120-60,
longitude=(place*17)%360-180, accuracy radius=10km. Encode these fields using
mmdbtype Map/String/Uint32/Float64/Uint16 and gzip/base64 the resulting DB.

The service fixture has 2000 invented usernames with 50 pairs each. IP index
is (account*50+offset)%20000+1, so every IP belongs to five accounts. SQLite
keeps all 100000 pairs; Memory retains a clearly disclosed 20000-pair subset.
Each cold/warm/live profile runs 20 iterations using this actual local MMDB.

Scale correctness/profile tests inject a120s build budget and130s request
budget, so race instrumentation does not turn a resource profile into a
production-deadline assertion. Ordinary services retain10s/12s defaults;
`[geography] build_timeout_secs` allows1–120s for slower devices. Payload,
account/IP/location totals and iteration assertions are unchanged.

The isolated SQLite race baseline at33da0d5 on the available local machine
passed20 iterations: cold p955.573538774s, warm p95331.062us, live
p95573.642253ms; total131.43s. This does not reproduce the external review's
timeout on that machine/load combination and does not predict other CPUs.

Physical aarch64 performance remains **NOT CHECKED**: the owner confirmed
that no ARM test device is available. Cross-compilation or emulation is not
reported as a device performance measurement.
