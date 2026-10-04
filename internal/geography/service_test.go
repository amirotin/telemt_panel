package geography

import (
	"context"
	"encoding/json"
	"errors"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/geoip"
	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/store"
)

type testClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *testClock) now() time.Time      { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *testClock) add(d time.Duration) { c.mu.Lock(); c.t = c.t.Add(d); c.mu.Unlock() }

type testLive struct {
	mu       sync.Mutex
	snapshot hub.UserIPLiveSnapshot
	epoch    uint64
}

func (l *testLive) UserIPSnapshot(now int64) hub.UserIPLiveSnapshot {
	l.mu.Lock()
	defer l.mu.Unlock()
	s := l.snapshot
	s.Records = append([]store.UserIPRecord(nil), s.Records...)
	s.Epoch = l.epoch
	return s
}
func (l *testLive) UserIPResetEpoch() uint64 { l.mu.Lock(); defer l.mu.Unlock(); return l.epoch }

func (l *testLive) UserIPSnapshotStatus(now int64) hub.UserIPSourceStatus {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.snapshot.Source
}

type testResolver struct {
	generation atomic.Uint64
	calls      atomic.Int32
	hook       func(context.Context, []string, uint64) error
}

func (r *testResolver) Generation() uint64 { return r.generation.Load() }
func (r *testResolver) LookupBatch(ctx context.Context, ips []string, expected uint64) (geoip.Status, []*geoip.Result, error) {
	r.calls.Add(1)
	if len(ips) > 512 {
		return geoip.Status{}, nil, errors.New("oversized batch")
	}
	if r.hook != nil {
		if err := r.hook(ctx, ips, expected); err != nil {
			return geoip.Status{}, nil, err
		}
	}
	if expected != r.Generation() {
		return geoip.Status{}, nil, geoip.ErrGenerationChanged
	}
	out := make([]*geoip.Result, len(ips))
	for i := range out {
		out[i] = located("DE", uint32(i+1), float64(i%80), 10)
	}
	return geoip.Status{State: geoip.StateReady, Available: true, Databases: []geoip.DatabaseStatus{}}, out, nil
}
func serviceFixture(t *testing.T) (*Service, *testClock, *testResolver, *testLive, *store.Memory) {
	t.Helper()
	clock := &testClock{t: time.Unix(1800000000, 0)}
	r := &testResolver{}
	l := &testLive{snapshot: hub.UserIPLiveSnapshot{Records: []store.UserIPRecord{{Username: "alice", IP: "1.1.1.1", Family: 4}, {Username: "bob", IP: "1.1.1.1", Family: 4}, {Username: "alice", IP: "2.2.2.2", Family: 4}}, Source: hub.UserIPSourceStatus{State: "collecting", LastSuccess: clock.now().Unix()}}}
	m, err := store.NewMemoryHistory()
	if err != nil {
		t.Fatal(err)
	}
	s := NewService(Dependencies{Live: l, History: m, GeoIP: r, State: m, Now: clock.now})
	t.Cleanup(func() { s.Close(); m.Close() })
	return s, clock, r, l, m
}

func TestServiceSnapshotLifecycle(t *testing.T) {
	s, clock, r, _, _ := serviceFixture(t)
	first, err := s.Overview(context.Background(), OverviewQuery{})
	if err != nil || first.Totals.UniqueIPs != 2 || first.Totals.Accounts != 2 || len(first.SnapshotID) != 32 {
		t.Fatalf("overview=%+v err=%v", first, err)
	}
	again, err := s.Overview(context.Background(), OverviewQuery{})
	if err != nil || again.SnapshotID != first.SnapshotID || r.calls.Load() != 1 {
		t.Fatal("warm request rebuilt")
	}
	users, err := s.Users(context.Background(), UsersQuery{SnapshotID: first.SnapshotID, GroupID: "country:DE", Limit: 1})
	if err != nil || users.Total != 2 || users.Items[0].Username != "alice" || users.NextCursor == nil {
		t.Fatalf("users=%+v err=%v", users, err)
	}
	second, err := s.Users(context.Background(), UsersQuery{SnapshotID: first.SnapshotID, GroupID: "country:DE", Limit: 1, Cursor: *users.NextCursor})
	if err != nil || len(second.Items) != 1 || second.Items[0].Username != "bob" {
		t.Fatalf("page=%+v %v", second, err)
	}
	if _, err = s.Users(context.Background(), UsersQuery{SnapshotID: first.SnapshotID, GroupID: "city:DE:1", Cursor: *users.NextCursor}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("cross-group cursor=%v", err)
	}
	clock.add(11 * time.Second)
	fresh, err := s.Overview(context.Background(), OverviewQuery{})
	if err != nil || fresh.SnapshotID == first.SnapshotID {
		t.Fatal("live reuse exceeded 10 seconds")
	}
	pinned, err := s.Overview(context.Background(), OverviewQuery{SnapshotID: first.SnapshotID})
	if err != nil || pinned.AsOf != first.AsOf {
		t.Fatal("pinned snapshot changed")
	}
	clock.add(31 * time.Second)
	pinned, err = s.Overview(context.Background(), OverviewQuery{SnapshotID: first.SnapshotID})
	if err != nil || pinned.State != "stale" || pinned.Source.AgeSeconds == nil || *pinned.Source.AgeSeconds != 42 {
		t.Fatalf("pinned age=%+v %v", pinned.Source, err)
	}
	clock.add(79 * time.Second)
	if _, err = s.Users(context.Background(), UsersQuery{SnapshotID: first.SnapshotID, GroupID: "country:DE"}); !errors.Is(err, ErrSnapshotExpired) {
		t.Fatalf("TTL extended on read: %v", err)
	}
}

func TestServiceMutationDuringBuild(t *testing.T) {
	t.Run("retry", func(t *testing.T) {
		s, _, r, _, m := serviceFixture(t)
		var once sync.Once
		r.hook = func(ctx context.Context, ips []string, gen uint64) error {
			once.Do(func() {
				if err := m.ResetUserIPHistory(""); err != nil {
					t.Error(err)
				}
				r.generation.Add(1)
			})
			return nil
		}
		if _, err := s.Overview(context.Background(), OverviewQuery{}); err != nil {
			t.Fatal(err)
		}
		if r.calls.Load() != 2 {
			t.Fatal("source change did not retry once")
		}
	})
	t.Run("changed-twice", func(t *testing.T) {
		s, _, r, _, _ := serviceFixture(t)
		r.hook = func(context.Context, []string, uint64) error { r.generation.Add(1); return nil }
		if _, err := s.Overview(context.Background(), OverviewQuery{}); !errors.Is(err, ErrSourceChanged) {
			t.Fatalf("repeated source change=%v", err)
		}
	})
	t.Run("direct-reset", func(t *testing.T) {
		s, _, _, _, m := serviceFixture(t)
		o, err := s.Overview(context.Background(), OverviewQuery{})
		if err != nil {
			t.Fatal(err)
		}
		if err = m.ResetUserIPHistory("alice"); err != nil {
			t.Fatal(err)
		}
		if _, err = s.Users(context.Background(), UsersQuery{SnapshotID: o.SnapshotID, GroupID: "country:DE"}); !errors.Is(err, ErrSnapshotExpired) {
			t.Fatalf("direct reset did not revoke cache: %v", err)
		}
	})
}

func TestServiceConcurrencyAndCancel(t *testing.T) {
	s, _, r, _, _ := serviceFixture(t)
	started := make(chan struct{}, 1)
	released := make(chan struct{})
	r.hook = func(ctx context.Context, ips []string, gen uint64) error {
		select {
		case started <- struct{}{}:
		default:
		}
		select {
		case <-released:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := s.Overview(ctx, OverviewQuery{}); done <- err }()
	<-started
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("caller cancellation=%v", err)
	}
	s.Close()
	s.Close()
	if _, err := s.Overview(context.Background(), OverviewQuery{}); err == nil {
		t.Fatal("closed service accepted build")
	}
}

func TestServiceWaiterBounds(t *testing.T) {
	s, _, resolver, _, _ := serviceFixture(t)
	release := make(chan struct{})
	started := make(chan struct{}, 1)
	resolver.hook = func(ctx context.Context, _ []string, _ uint64) error {
		select {
		case started <- struct{}{}:
		default:
		}
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	done := make(chan error, 8)
	for i := 0; i < 8; i++ {
		go func() { _, err := s.Overview(context.Background(), OverviewQuery{}); done <- err }()
	}
	<-started
	deadline := time.Now().Add(time.Second)
	for {
		s.mu.Lock()
		n := s.waiters
		s.mu.Unlock()
		if n == 8 {
			break
		}
		if time.Now().After(deadline) {
			close(release)
			t.Fatal("waiters did not join the shared build")
		}
		runtime.Gosched()
	}
	if _, err := s.Overview(context.Background(), OverviewQuery{}); !errors.Is(err, ErrBusy) {
		close(release)
		t.Fatalf("ninth waiter=%v", err)
	}
	close(release)
	for i := 0; i < 8; i++ {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	if resolver.calls.Load() != 1 {
		t.Fatalf("concurrent requests caused %d builds", resolver.calls.Load())
	}
}

type failingSettings struct {
	SettingsStore
	fail bool
}

func (s *failingSettings) SetSetting(k, v string) error {
	if s.fail {
		return errors.New("disk full")
	}
	return s.SettingsStore.SetSetting(k, v)
}

func TestServerLocationSettings(t *testing.T) {
	s, _, _, _, m := serviceFixture(t)
	settings, err := s.Settings(context.Background())
	if err != nil || settings.ServerLocation.Mode != "hidden" {
		t.Fatal("default setting is not hidden")
	}
	manual := ServerLocationConfig{Mode: "manual", Label: "Telemt", Latitude: ptr(0.0), Longitude: ptr(0.0)}
	if _, err = s.PutSettings(context.Background(), manual); err != nil {
		t.Fatal(err)
	}
	o, err := s.Overview(context.Background(), OverviewQuery{})
	if err != nil || o.Server.State != "ready" || o.Server.Location.Latitude != 0 {
		t.Fatal("manual zero position missing")
	}
	raw, _ := json.Marshal(o)
	if strings.Contains(string(raw), "public_ip") || strings.Contains(string(raw), "1.1.1.1") {
		t.Fatal("raw IP leaked")
	}
	for _, ip := range []string{"https://example.test", "example.test", "1.1.1.1:80", "1.1.1.1/32", "192.168.1.1", "100.64.0.1", "fe80::1%eth0", "::ffff:192.168.1.1"} {
		if _, err = s.PutSettings(context.Background(), ServerLocationConfig{Mode: "ip", PublicIP: ptr(ip)}); !errors.Is(err, ErrBadRequest) {
			t.Fatalf("accepted %s: %v", ip, err)
		}
	}
	if _, err = s.PutSettings(context.Background(), ServerLocationConfig{Mode: "manual", Latitude: ptr(91.0), Longitude: ptr(0.0)}); !errors.Is(err, ErrBadRequest) {
		t.Fatal("invalid coordinate accepted")
	}
	if _, err = s.PutSettings(context.Background(), ServerLocationConfig{Mode: "hidden", Latitude: ptr(0.0)}); !errors.Is(err, ErrBadRequest) {
		t.Fatal("hidden coordinate accepted")
	}
	state := &failingSettings{SettingsStore: m, fail: true}
	f := NewService(Dependencies{State: state})
	defer f.Close()
	if _, err = f.PutSettings(context.Background(), ServerLocationConfig{Mode: "hidden"}); err == nil {
		t.Fatal("failed persistence accepted")
	}
	after, err := f.Settings(context.Background())
	if err != nil || after.ServerLocation.Mode != "manual" {
		t.Fatal("failed save changed active configuration")
	}
}
