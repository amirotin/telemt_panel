package geoip

import (
	"context"
	"errors"
	"net/netip"
	"testing"
)

func TestLookupBatchGeneration(t *testing.T) {
	m := NewManager(t.TempDir(), newMemorySettings())
	defer m.Close()
	initial := m.Generation()
	if _, err := m.PutConfig(fileConfig(writeFixture(t, "country"), "", "")); err != nil {
		t.Fatal(err)
	}
	waitState(t, m, StateReady)
	gen := m.Generation()
	if gen == initial {
		t.Fatal("activation did not advance generation")
	}
	ips := make([]string, 512)
	for i := range ips {
		ips[i] = "81.2.69.142"
	}
	status, results, err := m.LookupBatch(context.Background(), ips, gen)
	if err != nil || !status.Available || len(results) != 512 || results[0].CountryCode != "GB" {
		t.Fatalf("batch: %+v %v", status, err)
	}
	m.cacheMu.Lock()
	cached := len(m.cache)
	m.cacheMu.Unlock()
	if cached != 0 {
		t.Fatalf("bulk read polluted page LRU: %d", cached)
	}
	if _, _, err = m.LookupBatch(context.Background(), append(ips, "1.1.1.1"), gen); err == nil {
		t.Fatal("accepted 513 IPs")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err = m.LookupBatch(ctx, ips, gen); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation = %v", err)
	}
	if _, _, err = m.LookupBatch(context.Background(), ips, initial); !errors.Is(err, ErrGenerationChanged) {
		t.Fatalf("old generation = %v", err)
	}
	if _, err = m.PutConfig(DefaultConfig()); err != nil {
		t.Fatal(err)
	}
	if _, _, err = m.LookupBatch(context.Background(), ips, gen); !errors.Is(err, ErrGenerationChanged) {
		t.Fatalf("disabled generation = %v", err)
	}
	disabled := m.Generation()
	m.Close()
	if _, _, err = m.LookupBatch(context.Background(), ips, disabled); !errors.Is(err, ErrGenerationChanged) {
		t.Fatalf("closed generation = %v", err)
	}
}

func TestLocationCacheCopies(t *testing.T) {
	m := NewManager(t.TempDir(), newMemorySettings())
	defer m.Close()
	if _, err := m.PutConfig(fileConfig("", "", writeFixture(t, "city"))); err != nil {
		t.Fatal(err)
	}
	waitState(t, m, StateReady)
	r := m.Lookup("81.2.69.142")
	if r == nil || r.Location == nil || r.CityID == nil {
		t.Fatal("missing location")
	}
	r.Location.Latitude = 0
	*r.CityID = 1
	if next := m.Lookup("81.2.69.142"); next.Location.Latitude == 0 || *next.CityID == 1 {
		t.Fatal("caller mutated cached result")
	}
	if !IsNonPublic(netip.MustParseAddr("::ffff:192.168.1.1")) {
		t.Fatal("mapped private address classified as public")
	}
}
