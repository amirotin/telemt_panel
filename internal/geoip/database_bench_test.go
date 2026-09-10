package geoip

import (
	"os"
	"strings"
	"testing"

	"github.com/oschwald/maxminddb-golang/v2"
)

// BenchmarkRecordSchema uses opt-in local files, never network downloads or
// production database assets in the repository. Example:
// GEOIP_BENCH_CITY=/path/to/City.mmdb go test -run '^$' -bench BenchmarkRecordSchema -benchtime=1x ./internal/geoip
func BenchmarkRecordSchema(b *testing.B) {
	for _, kind := range []Kind{KindCountry, KindASN, KindCity} {
		b.Run(string(kind), func(b *testing.B) {
			path := os.Getenv("GEOIP_BENCH_" + strings.ToUpper(string(kind)))
			if path == "" {
				b.Skip("set GEOIP_BENCH_COUNTRY/ASN/CITY to a local MMDB")
			}
			reader, err := maxminddb.Open(path)
			if err != nil {
				b.Fatal(err)
			}
			defer reader.Close()
			if err := reader.Verify(); err != nil {
				b.Fatal(err)
			}
			if !databaseTypeMatches(kind, reader.Metadata.DatabaseType) {
				b.Fatal("database kind mismatch")
			}
			unique := make(map[uintptr]struct{})
			networks := 0
			for result := range reader.Networks() {
				if err := result.Err(); err != nil {
					b.Fatal(err)
				}
				networks++
				unique[result.Offset()] = struct{}{}
			}
			b.ReportAllocs()
			b.ResetTimer()
			for range b.N {
				if err := verifyRecordSchema(reader, kind); err != nil {
					b.Fatal(err)
				}
			}
			b.StopTimer()
			b.ReportMetric(float64(networks), "networks")
			b.ReportMetric(float64(len(unique)), "unique-records")
		})
	}
}
