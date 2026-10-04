package geography

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/geoip"
	"github.com/amirotin/telemt_panel/internal/store"
)

func TestAggregateDisplayLimits(t *testing.T) {
	s, _, _, live, _ := serviceFixture(t)
	live.snapshot.Records = nil
	for i := 0; i < 201; i++ {
		live.snapshot.Records = append(live.snapshot.Records, store.UserIPRecord{Username: "alice", IP: fmt.Sprintf("2001:db8::%x", i+1), Family: 6})
	}
	overview, err := s.Overview(context.Background(), OverviewQuery{})
	if err != nil || len(overview.Points) != 200 || overview.Visible.OmittedPoints != 1 || overview.Totals.LocationCount != 201 || overview.Totals.UniqueIPs != 201 {
		t.Fatalf("display=%+v %v", overview.Visible, err)
	}
	places, err := s.Locations(context.Background(), LocationsQuery{SnapshotID: overview.SnapshotID, Kind: "location", Limit: 100})
	if err != nil || places.Total != 201 || places.NextCursor == nil {
		t.Fatalf("locations=%+v %v", places, err)
	}
	page2, err := s.Locations(context.Background(), LocationsQuery{SnapshotID: overview.SnapshotID, Kind: "location", Limit: 100, Cursor: *places.NextCursor})
	if err != nil || page2.NextCursor == nil {
		t.Fatal("second page missing")
	}
	page3, err := s.Locations(context.Background(), LocationsQuery{SnapshotID: overview.SnapshotID, Kind: "location", Cursor: *page2.NextCursor})
	if err != nil || len(page3.Items) != 1 {
		t.Fatal("last page missing")
	}
	selected := page3.Items[0].(Location).ID
	chosen, err := s.Overview(context.Background(), OverviewQuery{SnapshotID: overview.SnapshotID, LocationID: selected})
	found := false
	for _, p := range chosen.Points {
		found = found || p.ID == selected
	}
	if err != nil || !found || len(chosen.Points) != 200 || chosen.Totals.UniqueIPs != 201 {
		t.Fatal("selected omitted point not included")
	}
}

func TestServiceHistoryReuseLRUAndFilters(t *testing.T) {
	s, clock, r, _, history := serviceFixture(t)
	now := clock.now().Unix()
	record := store.UserIPRecord{Username: "deleted-user", IP: "1.1.1.1", Family: 4, First: now, Last: now, Observations: 1, Source: 2}
	if err := history.ApplyUserIPBatch(store.UserIPBatch{ID: "first", Through: now, Records: []store.UserIPRecord{record}}); err != nil {
		t.Fatal(err)
	}
	first, err := s.Overview(context.Background(), OverviewQuery{Range: "7d", Family: "4"})
	if err != nil || first.Range != "7d" || first.Source.Durable == nil || *first.Source.Durable || *first.Source.EffectiveFrom != now-86400 {
		t.Fatalf("history=%+v %v", first.Source, err)
	}
	pinned, err := s.Overview(context.Background(), OverviewQuery{SnapshotID: first.SnapshotID})
	if err != nil || pinned.Range != "7d" || pinned.Family != "4" {
		t.Fatal("pinned query applied defaults")
	}
	if _, err = s.Overview(context.Background(), OverviewQuery{SnapshotID: first.SnapshotID, Range: "now"}); !errors.Is(err, ErrBadRequest) {
		t.Fatal("snapshot range mismatch accepted")
	}
	clock.add(59 * time.Second)
	same, err := s.Overview(context.Background(), OverviewQuery{Range: "7d", Family: "4"})
	if err != nil || same.SnapshotID != first.SnapshotID || r.calls.Load() != 1 {
		t.Fatal("history not reused for 60 seconds")
	}
	clock.add(2 * time.Second)
	second, err := s.Overview(context.Background(), OverviewQuery{Range: "7d", Family: "4"})
	if err != nil || second.SnapshotID == first.SnapshotID {
		t.Fatal("history cache reused too long")
	}
	if _, err = s.Overview(context.Background(), OverviewQuery{}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Overview(context.Background(), OverviewQuery{SnapshotID: first.SnapshotID}); !errors.Is(err, ErrSnapshotExpired) {
		t.Fatal("third snapshot failed to evict LRU")
	}
}

func TestServiceResourceBounds(t *testing.T) {
	pairs := make([]Pair, 100000)
	resolved := make(map[netip.Addr]*geoip.Result, len(pairs))
	for i := range pairs {
		p := pair(fmt.Sprintf("user%04d", i/50), fmt.Sprintf("2001:db8::%x:%x", (i+1)>>16, (i+1)&65535))
		pairs[i] = p
		resolved[p.IP] = located("DE", uint32(i+1), 0, 0)
	}
	if _, err := Aggregate(context.Background(), Input{Pairs: pairs}, resolved); !errors.Is(err, ErrCapacity) {
		t.Fatalf("unbounded worst-case build: %v", err)
	}
	name := strings.Repeat("ж", 200) + "\n"
	r := located("DE", 1, 0, 0)
	r.City = name
	d, err := Aggregate(context.Background(), Input{Pairs: []Pair{pair("alice", "1.1.1.1")}}, map[netip.Addr]*geoip.Result{netip.MustParseAddr("1.1.1.1"): r})
	if err != nil || len([]rune(*d.Locations[0].Name)) != 80 || strings.Contains(*d.Locations[0].Name, "\n") {
		t.Fatal("label bound failed")
	}
}
