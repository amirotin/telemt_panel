package geography

import (
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/geoip"
	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/store"
)

func scaleResolver(t *testing.T, state SettingsStore) *geoip.Manager {
	t.Helper()
	compressed, err := base64.StdEncoding.DecodeString(scaleFixtureGzipBase64)
	if err != nil {
		t.Fatal(err)
	}
	gz, err := gzip.NewReader(strings.NewReader(string(compressed)))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(gz)
	gz.Close()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "synthetic-city.mmdb")
	if err = os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	manager := geoip.NewManager(t.TempDir(), state)
	t.Cleanup(manager.Close)
	config := geoip.DefaultConfig()
	config.Enabled = true
	config.Source = geoip.SourceFiles
	config.Schedule = geoip.ScheduleManual
	config.Country.Enabled = false
	config.ASN.Enabled = false
	config.City = geoip.DatabaseConfig{Enabled: true, Location: path}
	if _, err = manager.PutConfig(config); err != nil {
		t.Fatal(err)
	}
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for manager.Status().State == geoip.StateUpdating {
		select {
		case <-deadline.C:
			t.Fatal("synthetic MMDB activation timed out")
		case <-tick.C:
		}
	}
	if !manager.Status().Available {
		t.Fatalf("MMDB status=%+v", manager.Status())
	}
	return manager
}

func scaleRecords() []store.UserIPRecord {
	const now int64 = 1800000000
	records := make([]store.UserIPRecord, 0, 100000)
	for account := 0; account < 2000; account++ {
		for j := 0; j < 50; j++ {
			index := (account*50+j)%20000 + 1
			records = append(records, store.UserIPRecord{Username: fmt.Sprintf("fixture%04d", account), IP: fmt.Sprintf("2001:db8::%x", index), Family: 6, First: now, Last: now, Observations: 1, Source: 1})
		}
	}
	return records
}

func runScaleProjection(t *testing.T, history store.HistoryStore, expectedAccounts int64) {
	t.Helper()
	if testing.Short() {
		t.Skip("scale projection")
	}
	state, err := store.NewMemoryHistory()
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	resolver := scaleResolver(t, state)
	records := scaleRecords()
	for part := 0; part < 5; part++ {
		if err = history.ApplyUserIPBatch(store.UserIPBatch{ID: fmt.Sprintf("scale-%d", part), Through: 1800000000 + int64(part), Records: records[part*20000 : (part+1)*20000]}); err != nil {
			t.Fatal(err)
		}
	}
	clock := &testClock{t: time.Unix(1800000004, 0)}
	live := &testLive{snapshot: hub.UserIPLiveSnapshot{Records: records[:20000], Source: hub.UserIPSourceStatus{State: "collecting", LastSuccess: 1800000004}}}
	service := NewService(Dependencies{History: history, Live: live, GeoIP: resolver, State: state, Now: clock.now})
	defer service.Close()
	var cold, warm, nowSamples []time.Duration
	var maxOverview, maxPage int
	for i := 0; i < 20; i++ {
		clock.add(61 * time.Second)
		start := time.Now()
		overview, err := service.Overview(context.Background(), OverviewQuery{Range: "7d", Family: "all"})
		cold = append(cold, time.Since(start))
		if err != nil {
			t.Fatal(err)
		}
		if overview.Totals.UniqueIPs != 20000 || overview.Totals.Accounts != expectedAccounts || overview.Totals.LocationCount != 2000 || overview.Totals.CountryCount != 100 || overview.Quality.Located != 20000 {
			t.Fatalf("fixture totals=%+v quality=%+v", overview.Totals, overview.Quality)
		}
		start = time.Now()
		cached, err := service.Overview(context.Background(), OverviewQuery{Range: "7d", Family: "all"})
		warm = append(warm, time.Since(start))
		if err != nil || cached.SnapshotID != overview.SnapshotID {
			t.Fatal("warm snapshot rebuilt")
		}
		raw, _ := json.Marshal(overview)
		maxOverview = max(maxOverview, len(raw))
		page, err := service.Locations(context.Background(), LocationsQuery{SnapshotID: overview.SnapshotID, Kind: "location", Limit: 100})
		if err != nil || page.Total != 2000 {
			t.Fatal("scale paging", err)
		}
		raw, _ = json.Marshal(page)
		maxPage = max(maxPage, len(raw))
		live.mu.Lock()
		live.snapshot.Source.LastSuccess = clock.now().Unix()
		live.mu.Unlock()
		start = time.Now()
		active, err := service.Overview(context.Background(), OverviewQuery{Range: "now", Family: "all"})
		nowSamples = append(nowSamples, time.Since(start))
		if err != nil || active.Totals.UniqueIPs != 20000 || active.Totals.Accounts != 400 {
			t.Fatal("scale live", err)
		}
	}
	p95 := func(values []time.Duration) time.Duration {
		sort.Slice(values, func(i, j int) bool { return values[i] < values[j] })
		return values[18]
	}
	if maxOverview > 256<<10 || maxPage > 64<<10 {
		t.Fatalf("payload budget: overview=%d page=%d", maxOverview, maxPage)
	}
	t.Logf("PROFILE seed=20261004 history_accounts=%d cold_history_p95=%s warm_p95=%s live_p95=%s overview_bytes=%d page_bytes=%d", expectedAccounts, p95(cold), p95(warm), p95(nowSamples), maxOverview, maxPage)
}

func TestServiceScaleMemory(t *testing.T) {
	history, _ := store.NewMemoryHistory()
	defer history.Close()
	runScaleProjection(t, history, 400)
}
