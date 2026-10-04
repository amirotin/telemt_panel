package geography

import (
	"context"
	"errors"
	"github.com/amirotin/telemt_panel/internal/geoip"
	"math"
	"net/netip"
	"reflect"
	"testing"
)

func ptr[T any](v T) *T         { return &v }
func pair(user, ip string) Pair { return Pair{Username: user, IP: netip.MustParseAddr(ip)} }
func located(code string, id uint32, lat, lon float64) *geoip.Result {
	return &geoip.Result{State: geoip.ResultFound, CountryCode: code, CountryName: code, CityID: ptr(id), City: "City", Location: &geoip.Location{Latitude: lat, Longitude: lon, AccuracyRadiusKM: ptr(uint16(10))}}
}

func TestAggregateSetSemantics(t *testing.T) {
	pairs := []Pair{pair("alice", "1.1.1.1"), pair("bob", "1.1.1.1"), pair("alice", "::ffff:1.1.1.1"), pair("alice", "2001:db8::1")}
	resolved := map[netip.Addr]*geoip.Result{netip.MustParseAddr("1.1.1.1"): located("DE", 1, 50, 10), netip.MustParseAddr("2001:db8::1"): located("JP", 2, 35, 139)}
	d, err := Aggregate(context.Background(), Input{Pairs: pairs, Range: "now", Family: "all", AsOf: 1800000000}, resolved)
	if err != nil || d.Totals.UniqueIPs != 2 || d.Totals.Accounts != 2 || d.Totals.CountryCount != 2 || d.Totals.LocationCount != 2 || d.Quality.Located != 2 {
		t.Fatalf("totals=%+v quality=%+v %v", d.Totals, d.Quality, err)
	}
	if len(d.Memberships["city:DE:1"]) != 2 || d.Memberships["city:DE:1"][0].UniqueIPs != 1 {
		t.Fatal("shared IP lost account membership")
	}
	reverse := []Pair{pairs[3], pairs[2], pairs[1], pairs[0]}
	other, err := Aggregate(context.Background(), Input{Pairs: reverse, Range: "now", Family: "all"}, resolved)
	if err != nil || !reflect.DeepEqual(d.Countries, other.Countries) || !reflect.DeepEqual(d.Locations, other.Locations) || !reflect.DeepEqual(d.Memberships, other.Memberships) || !reflect.DeepEqual(d.Accounts, other.Accounts) {
		t.Fatal("input order changed aggregates")
	}
	four, err := Aggregate(context.Background(), Input{Pairs: pairs, Family: "4"}, resolved)
	if err != nil || four.Totals.UniqueIPs != 1 || four.Totals.Accounts != 2 {
		t.Fatal("family/mapped semantics lost")
	}
}

func TestAggregateUnknownAndCountryOnly(t *testing.T) {
	pairs := []Pair{pair("a", "192.168.1.1"), pair("b", "1.1.1.1"), pair("c", "2.2.2.2"), pair("d", "3.3.3.3"), pair("e", "4.4.4.4"), pair("f", "5.5.5.5")}
	resolved := map[netip.Addr]*geoip.Result{
		netip.MustParseAddr("1.1.1.1"): {State: geoip.ResultFound, ASN: 1},
		netip.MustParseAddr("2.2.2.2"): {State: geoip.ResultFound, CountryCode: "DE"},
		netip.MustParseAddr("3.3.3.3"): {State: geoip.ResultFound, CountryCode: "DE", CityID: ptr(uint32(7))},
		netip.MustParseAddr("4.4.4.4"): {State: geoip.ResultFound, CountryCode: "DE", CountryConflict: true, Location: &geoip.Location{Latitude: 0, Longitude: 0}},
	}
	d, err := Aggregate(context.Background(), Input{Pairs: pairs, Family: "all"}, resolved)
	if err != nil || d.Totals.UniqueIPs != 6 || d.Totals.LocationCount != 1 || d.Quality.Private != 1 || d.Quality.NotFound != 1 || d.Quality.CountryOnly != 3 || d.Quality.Unavailable != 1 || d.Quality.GeoConflicts != 1 {
		t.Fatalf("quality=%+v totals=%+v %v", d.Quality, d.Totals, err)
	}
	for _, id := range []string{"unknown:private", "unknown:not_found", "unknown:unavailable", "country-only:DE", "city:DE:7"} {
		if len(d.Memberships[id]) == 0 {
			t.Fatalf("unreachable group %s", id)
		}
	}
	for _, l := range d.Locations {
		if l.Location != nil {
			t.Fatal("fabricated position")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Aggregate(ctx, Input{Pairs: pairs}, resolved); !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation lost")
	}
}

func TestLocationIdentityAndRadius(t *testing.T) {
	a, b := located("DE", 7, 0, 0), located("DE", 7, 1, 1)
	if LocationID(a) != "city:DE:7" || LocationID(located("JP", 7, 0, 0)) == LocationID(a) {
		t.Fatal("city identity not scoped to country")
	}
	p := &geoip.Result{Location: &geoip.Location{Latitude: math.Copysign(0, -1), Longitude: 1.23456}}
	if LocationID(p) != "point:ZZ:0.0000:1.2346" {
		t.Fatalf("point ID=%s", LocationID(p))
	}
	*a.Location.AccuracyRadiusKM = 65535
	d, err := Aggregate(context.Background(), Input{Pairs: []Pair{pair("a", "1.1.1.1"), pair("a", "2.2.2.2")}}, map[netip.Addr]*geoip.Result{netip.MustParseAddr("1.1.1.1"): b, netip.MustParseAddr("2.2.2.2"): a})
	if err != nil {
		t.Fatal(err)
	}
	l := d.Locations[0]
	if l.Location.Latitude != 0 || l.Location.Longitude != 0 || l.Location.AccuracyRadiusKM == nil || *l.Location.AccuracyRadiusKM != 65535 {
		t.Fatalf("radius=%+v", l.Location)
	}
	*b.Location.AccuracyRadiusKM = 65535
	d, err = Aggregate(context.Background(), Input{Pairs: []Pair{pair("a", "1.1.1.1"), pair("a", "2.2.2.2")}}, map[netip.Addr]*geoip.Result{netip.MustParseAddr("1.1.1.1"): b, netip.MustParseAddr("2.2.2.2"): a})
	if err != nil || *d.Locations[0].Location.AccuracyRadiusKM <= 65535 {
		t.Fatal("group radius overflowed uint16")
	}
	b.Location.AccuracyRadiusKM = nil
	d, err = Aggregate(context.Background(), Input{Pairs: []Pair{pair("a", "1.1.1.1"), pair("a", "2.2.2.2")}}, map[netip.Addr]*geoip.Result{netip.MustParseAddr("1.1.1.1"): b, netip.MustParseAddr("2.2.2.2"): a})
	if err != nil || d.Locations[0].Location.AccuracyRadiusKM != nil {
		t.Fatal("unknown radius fabricated")
	}
}
