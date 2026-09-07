package geoip

import (
	"errors"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDefaultConfigAndValidation(t *testing.T) {
	got := DefaultConfig()
	if got.Enabled || got.Source != SourceCommunity || got.Schedule != ScheduleWeekly {
		t.Fatalf("defaults = %+v", got)
	}
	if !got.Country.Enabled || !got.ASN.Enabled || got.City.Enabled {
		t.Fatalf("database defaults = %+v", got)
	}
	if err := got.Validate(); err != nil {
		t.Fatalf("default config: %v", err)
	}

	tests := []Config{
		{Source: "other", Schedule: ScheduleWeekly, Country: DatabaseConfig{Enabled: true}},
		{Source: SourceCommunity, Schedule: "hourly", Country: DatabaseConfig{Enabled: true}},
		{Enabled: true, Source: SourceCommunity, Schedule: ScheduleWeekly},
		{Source: SourceURLs, Schedule: ScheduleWeekly, Country: DatabaseConfig{Enabled: true, Location: "http://example.test/country.mmdb"}},
		{Source: SourceURLs, Schedule: ScheduleWeekly, Country: DatabaseConfig{Enabled: true, Location: "https://user@example.test/country.mmdb"}},
		{Source: SourceURLs, Schedule: ScheduleWeekly, Country: DatabaseConfig{Enabled: true, Location: "https://example.test/country.mmdb#fragment"}},
		{Source: SourceFiles, Schedule: ScheduleWeekly, Country: DatabaseConfig{Enabled: true, Location: "relative.mmdb"}},
	}
	for i, cfg := range tests {
		if err := cfg.Validate(); err == nil {
			t.Errorf("case %d accepted invalid config: %+v", i, cfg)
		}
	}

	valid := Config{
		Enabled: true, Source: SourceURLs, Schedule: ScheduleDaily,
		Country: DatabaseConfig{Enabled: true, Location: "https://example.test/country.mmdb"},
		ASN:     DatabaseConfig{Enabled: true, Location: "https://example.test/asn.mmdb?edition=test"},
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid URL config: %v", err)
	}
}

func TestOpenBundleRejectsOversizedFileBeforeMmap(t *testing.T) {
	path := filepath.Join(t.TempDir(), "oversized.mmdb")
	if err := os.WriteFile(path, []byte("placeholder"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(path, maxDatabaseBytes+1); err != nil {
		t.Fatal(err)
	}
	if _, err := openBundle(map[Kind]string{KindCountry: path}, 1); !errors.Is(err, errDatabaseTooLarge) {
		t.Fatalf("oversized database error = %v", err)
	}
}

func TestBuildEpochMustBeSane(t *testing.T) {
	now := int64(2_000_000_000)
	for _, epoch := range []uint{0, uint(now + int64(49*time.Hour/time.Second))} {
		if validBuildEpoch(epoch, now) {
			t.Errorf("accepted build epoch %d", epoch)
		}
	}
	if !validBuildEpoch(uint(now), now) {
		t.Fatal("rejected current build epoch")
	}
}

func TestOpenBundleLooksUpCountryASNAndCity(t *testing.T) {
	b, err := openBundle(map[Kind]string{
		KindCountry: writeFixture(t, "country"),
		KindASN:     writeFixture(t, "asn"),
		KindCity:    writeFixture(t, "city"),
	}, 1234)
	if err != nil {
		t.Fatal(err)
	}
	defer b.close()

	for _, raw := range []string{"81.2.69.142", "::ffff:81.2.69.142"} {
		result, err := b.lookup(netip.MustParseAddr(raw))
		if err != nil {
			t.Fatalf("lookup %s: %v", raw, err)
		}
		if result.State != ResultFound || result.CountryCode != "GB" || result.CountryName != "United Kingdom" {
			t.Fatalf("country %s = %+v", raw, result)
		}
		if result.City != "London" {
			t.Fatalf("city %s = %+v", raw, result)
		}
	}

	result, err := b.lookup(netip.MustParseAddr("1.0.0.1"))
	if err != nil {
		t.Fatal(err)
	}
	if result.State != ResultFound || result.ASN != 15169 || result.Organization != "Google Inc." {
		t.Fatalf("asn = %+v", result)
	}

	result, err = b.lookup(netip.MustParseAddr("2001:218::1"))
	if err != nil {
		t.Fatal(err)
	}
	if result.State != ResultFound || result.CountryCode != "JP" || result.CountryName != "Japan" || result.CountryNameRU != "Япония" {
		t.Fatalf("ipv6 = %+v", result)
	}

	result, err = b.lookup(netip.MustParseAddr("203.0.113.254"))
	if err != nil {
		t.Fatal(err)
	}
	if result.State != ResultNotFound {
		t.Fatalf("missing = %+v", result)
	}
}

func TestOpenBundleRejectsWrongTypeCorruptAndNonRegular(t *testing.T) {
	if _, err := openBundle(map[Kind]string{KindCountry: writeFixture(t, "asn")}, 1); err == nil {
		t.Fatal("ASN database accepted as Country")
	}
	corrupt := filepath.Join(t.TempDir(), "corrupt.mmdb")
	if err := os.WriteFile(corrupt, []byte("not an mmdb"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := openBundle(map[Kind]string{KindCountry: corrupt}, 1); err == nil {
		t.Fatal("corrupt database accepted")
	}
	dir := t.TempDir()
	if _, err := openBundle(map[Kind]string{KindCountry: dir}, 1); err == nil {
		t.Fatal("directory accepted")
	}
}
