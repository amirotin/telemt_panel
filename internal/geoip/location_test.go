package geoip

import (
	"math"
	"net/netip"
	"testing"
)

func value[T any](v T) *T { return &v }

func TestLocationPresenceAndBounds(t *testing.T) {
	for _, tc := range []struct {
		name           string
		lat, lon       *float64
		valid, present bool
	}{
		{"zero", value(0.0), value(0.0), true, true},
		{"bounds", value(-90.0), value(180.0), true, true},
		{"absent", nil, nil, true, false},
		{"latitude-only", value(1.0), nil, true, false},
		{"longitude-only", nil, value(1.0), true, false},
		{"latitude-invalid", value(91.0), value(0.0), false, false},
		{"longitude-invalid", value(0.0), value(-181.0), false, false},
		{"nan", value(math.NaN()), value(0.0), false, false},
		{"infinity", value(0.0), value(math.Inf(1)), false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var record cityRecord
			record.Location.Latitude, record.Location.Longitude = tc.lat, tc.lon
			loc, err := record.location()
			if (err == nil) != tc.valid || (loc != nil) != tc.present {
				t.Fatalf("location = %+v, err = %v", loc, err)
			}
			if loc != nil && (loc.Latitude != *tc.lat || loc.Longitude != *tc.lon || loc.AccuracyRadiusKM != nil) {
				t.Fatalf("presence lost: %+v", loc)
			}
		})
	}
	b, err := openBundle(map[Kind]string{KindCity: writeFixture(t, "city")}, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer b.close()
	r, err := b.lookup(netip.MustParseAddr("81.2.69.142"))
	if err != nil || r.CityID == nil || *r.CityID != 2643743 || r.Location == nil || r.Location.Latitude == 0 {
		t.Fatalf("City fixture fields: %+v, %v", r, err)
	}
}

func TestCountryCityConflict(t *testing.T) {
	r := Result{CountryCode: "DE"}
	var record cityRecord
	record.Country.ISOCode = "GB"
	record.City.Names = map[string]string{"en": "London"}
	record.City.ID = value(uint32(2643743))
	record.Location.Latitude, record.Location.Longitude = value(51.5), value(-0.1)
	if err := applyCity(&r, record); err != nil {
		t.Fatal(err)
	}
	if !r.CountryConflict || r.CountryCode != "DE" || r.City != "" || r.CityID != nil || r.Location != nil {
		t.Fatalf("contradictory City leaked: %+v", r)
	}
}

func TestLocationMMDBPresenceAndInvalidActivation(t *testing.T) {
	for _, name := range []string{"zero", "absent", "latitude-only", "longitude-only"} {
		t.Run(name, func(t *testing.T) {
			b, err := openBundle(map[Kind]string{KindCity: writeFixture(t, "location:"+name)}, 1)
			if err != nil {
				t.Fatal(err)
			}
			defer b.close()
			r, err := b.lookup(netip.MustParseAddr("81.2.69.142"))
			if err != nil || (r.Location != nil) != (name == "zero") {
				t.Fatalf("result=%+v err=%v", r, err)
			}
			if name == "zero" && (r.Location.Latitude != 0 || r.Location.Longitude != 0 || r.Location.AccuracyRadiusKM == nil || *r.Location.AccuracyRadiusKM != 65535) {
				t.Fatalf("zero/radius presence lost: %+v", r.Location)
			}
		})
	}
	m := NewManager(t.TempDir(), newMemorySettings())
	defer m.Close()
	if _, err := m.PutConfig(fileConfig("", "", writeFixture(t, "city"))); err != nil {
		t.Fatal(err)
	}
	waitState(t, m, StateReady)
	gen := m.Generation()
	for _, name := range []string{"bad-latitude", "bad-longitude", "bad-type", "bad-radius"} {
		if _, err := m.PutConfig(fileConfig("", "", writeFixture(t, "location:"+name))); err != nil {
			t.Fatal(err)
		}
		status := waitState(t, m, StateError)
		if !status.Available || m.Generation() != gen {
			t.Fatalf("invalid %s replaced generation", name)
		}
		if r := m.Lookup("81.2.69.142"); r == nil || r.City != "London" || r.Location == nil {
			t.Fatalf("previous City lost after %s: %+v", name, r)
		}
	}
}
