package geography

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/netip"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/amirotin/telemt_panel/internal/geoip"
	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/store"
)

// LiveSource copies active observations and exposes the collector reset barrier.
type LiveSource interface {
	UserIPSnapshot(int64) hub.UserIPLiveSnapshot
	UserIPResetEpoch() uint64
}

// HistorySource reads a consistent history version without per-account requests.
type HistorySource interface {
	ReadUserIPSnapshot(context.Context, int64, int64) (store.UserIPReadSnapshot, error)
	UserIPEpoch() uint64
}

// Resolver reads local MMDB batches from one explicit generation.
type Resolver interface {
	Generation() uint64
	LookupBatch(context.Context, []string, uint64) (geoip.Status, []*geoip.Result, error)
}

// SettingsStore persists panel-owned settings.
type SettingsStore interface {
	GetSetting(string) (string, bool, error)
	SetSetting(string, string) error
}

// Dependencies are the existing observation sources, local resolver and injectable clock.
type Dependencies struct {
	Live    LiveSource
	History HistorySource
	GeoIP   Resolver
	State   SettingsStore
	Now     func() time.Time
}

// OverviewQuery selects a source, or a view of an existing opaque snapshot.
type OverviewQuery struct {
	Range                           Range
	Family                          Family
	Country, LocationID, SnapshotID string
}

// LocationsQuery selects a stable group list from one snapshot.
type LocationsQuery struct {
	SnapshotID, Kind, Country, Cursor string
	Limit                             int
}

// UsersQuery selects compact account memberships, never raw IPs.
type UsersQuery struct {
	SnapshotID, GroupID, Cursor string
	Limit                       int
}

type epochs struct{ history, live, geoip, settings uint64 }
type key struct {
	window Range
	family Family
}
type snapshot struct {
	id      string
	key     key
	epochs  epochs
	created time.Time
	asOf    int64
	source  SourceMetadata
	geoip   geoip.Status
	server  ServerPosition
	data    *SnapshotData
}
type buildWork struct {
	key    key
	done   chan struct{}
	cancel context.CancelFunc
	result *snapshot
	err    error
}

// Service owns at most two immutable snapshots and one demand-driven build.
type Service struct {
	deps             Dependencies
	now              func() time.Time
	ctx              context.Context
	cancel           context.CancelFunc
	mu               sync.Mutex
	cache            []*snapshot
	work             *buildWork
	waiters          int
	closed           bool
	wg               sync.WaitGroup
	closeOnce        sync.Once
	settingsMu       sync.RWMutex
	config           ServerLocationConfig
	settingsErr      error
	settingsEpoch    atomic.Uint64
	settingsSnapshot atomic.Pointer[settingsVersion]
}

type settingsVersion struct {
	config ServerLocationConfig
	err    error
}

// NewService restores state without querying Telemt or building projections.
func NewService(deps Dependencies) *Service {
	if deps.Now == nil {
		deps.Now = time.Now
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Service{deps: deps, now: deps.Now, ctx: ctx, cancel: cancel}
	s.restoreSettings()
	s.settingsSnapshot.Store(&settingsVersion{config: s.config, err: s.settingsErr})
	return s
}

func isPrivate(addr netip.Addr) bool { return geoip.IsNonPublic(addr) }
func (s *Service) currentEpochs() epochs {
	e := epochs{settings: s.settingsEpoch.Load()}
	if s.deps.History != nil {
		e.history = s.deps.History.UserIPEpoch()
	}
	if s.deps.Live != nil {
		e.live = s.deps.Live.UserIPResetEpoch()
	}
	if s.deps.GeoIP != nil {
		e.geoip = s.deps.GeoIP.Generation()
	}
	return e
}
func validRange(r Range) bool   { return r == "now" || r == "24h" || r == "7d" || r == "30d" }
func validFamily(f Family) bool { return f == "all" || f == "4" || f == "6" }
func validCountry(c string) bool {
	if len(c) != 2 {
		return false
	}
	for _, r := range c {
		if r < 'A' || r > 'Z' {
			return false
		}
	}
	return true
}

func (s *Service) build(ctx context.Context, k key) (*snapshot, error) {
	for attempt := 0; attempt < 2; attempt++ {
		e := s.currentEpochs()
		result, err := s.buildVersion(ctx, k, e)
		if err == nil && e == s.currentEpochs() {
			return result, nil
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if errors.Is(err, geoip.ErrGenerationChanged) || errors.Is(err, ErrSourceChanged) || e != s.currentEpochs() {
			continue
		}
		return nil, err
	}
	return nil, ErrSourceChanged
}

func (s *Service) buildVersion(ctx context.Context, k key, e epochs) (*snapshot, error) {
	asOf := s.now().Unix()
	if asOf <= 0 {
		return nil, ErrSourceChanged
	}
	src := SourceMetadata{Kind: "live", State: "unavailable"}
	var records []store.UserIPRecord
	if k.window == "now" {
		if s.deps.Live != nil {
			live := s.deps.Live.UserIPSnapshot(asOf)
			if live.Epoch != e.live {
				return nil, ErrSourceChanged
			}
			src.Partial, src.InputTruncated, src.InvalidUsers = live.Partial, live.Truncated, live.InvalidUsers
			src.CollectionGap = live.Source.Gap
			if live.Source.LastSuccess > 0 {
				observed := live.Source.LastSuccess
				src.ObservedAt = &observed
				src.State = live.Source.State
				records = live.Records
			}
		}
	} else {
		src.Kind = "history"
		duration := int64(86400)
		if k.window == "7d" {
			duration *= 7
		}
		if k.window == "30d" {
			duration *= 30
		}
		from := max(int64(0), asOf-duration)
		src.RequestedFrom = &from
		if s.deps.History != nil {
			history, err := s.deps.History.ReadUserIPSnapshot(ctx, from, asOf)
			if err != nil {
				return nil, err
			}
			if history.Epoch != e.history {
				return nil, ErrSourceChanged
			}
			effective := max(from, asOf-int64(history.Retention/time.Second))
			days := int64(history.Retention / (24 * time.Hour))
			durable := history.Durable
			src.EffectiveFrom, src.RetentionDays, src.Durable = &effective, &days, &durable
			src.Partial = history.Truncated || history.Collection.Limited || history.Collection.Gap
			src.InputTruncated, src.CollectionGap = history.Truncated, history.Collection.Gap
			if history.Collection.Through > 0 {
				observed := history.Collection.Through
				src.ObservedAt = &observed
				src.State = "ready"
				records = history.Records
			}
		}
		if s.deps.Live != nil {
			src.Pending = s.deps.Live.UserIPSnapshot(asOf).Source.Pending
		}
	}
	settings, err := s.Settings(ctx)
	if err != nil {
		return nil, err
	}
	pairs := make([]Pair, 0, len(records))
	unique := make(map[netip.Addr]struct{}, len(records))
	for i, r := range records {
		if i%512 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
		addr, err := netip.ParseAddr(r.IP)
		if err != nil || addr.Zone() != "" || r.Username == "" || len(r.Username) > 256 {
			src.Partial = true
			continue
		}
		addr = addr.Unmap()
		if k.family == "4" && !addr.Is4() || k.family == "6" && !addr.Is6() {
			continue
		}
		pairs = append(pairs, Pair{Username: r.Username, IP: addr})
		unique[addr] = struct{}{}
	}
	config := settings.ServerLocation
	if config.Mode == "ip" && config.PublicIP != nil {
		addr, _ := netip.ParseAddr(*config.PublicIP)
		unique[addr] = struct{}{}
	}
	addresses := make([]netip.Addr, 0, len(unique))
	for addr := range unique {
		addresses = append(addresses, addr)
	}
	sort.Slice(addresses, func(i, j int) bool { return addresses[i].Compare(addresses[j]) < 0 })
	resolved := make(map[netip.Addr]*geoip.Result, len(addresses))
	status := geoip.DisabledStatus()
	for start := 0; start < len(addresses) || start == 0; start += 512 {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if e != s.currentEpochs() {
			return nil, ErrSourceChanged
		}
		end := min(start+512, len(addresses))
		ips := make([]string, end-start)
		for i, addr := range addresses[start:end] {
			ips[i] = addr.String()
		}
		if s.deps.GeoIP != nil {
			var results []*geoip.Result
			status, results, err = s.deps.GeoIP.LookupBatch(ctx, ips, e.geoip)
			if err != nil {
				return nil, err
			}
			if len(results) != len(ips) {
				return nil, ErrSourceChanged
			}
			for i, r := range results {
				resolved[addresses[start+i]] = r
			}
		}
		if len(addresses) == 0 {
			break
		}
	}
	data, err := Aggregate(ctx, Input{Pairs: pairs, Range: k.window, Family: k.family, AsOf: asOf, Source: src}, resolved)
	if err != nil {
		return nil, err
	}
	server := ServerPosition{State: "hidden", Label: config.Label}
	if config.Mode == "manual" {
		origin := "manual"
		server.State, server.Origin = "ready", &origin
		server.Location = &geoip.Location{Latitude: *config.Latitude, Longitude: *config.Longitude}
	}
	if config.Mode == "ip" {
		origin := "geoip"
		server.State, server.Origin = "unresolved", &origin
		addr, _ := netip.ParseAddr(*config.PublicIP)
		if r := resolved[addr]; r != nil && !r.CountryConflict && validPosition(r.Location) {
			server.State = "ready"
			location := *r.Location
			server.Location = &location
		}
	}
	if e != s.currentEpochs() {
		return nil, ErrSourceChanged
	}
	var id [16]byte
	if _, err = rand.Read(id[:]); err != nil {
		return nil, err
	}
	return &snapshot{id: hex.EncodeToString(id[:]), key: k, epochs: e, created: s.now(), asOf: asOf, source: src, geoip: status, server: server, data: data}, nil
}

// Close cancels and waits for the demand-driven worker; repeated calls are safe.
func (s *Service) Close() {
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closed = true
		s.cancel()
		if s.work != nil {
			s.work.cancel()
		}
		s.cache = nil
		s.mu.Unlock()
		s.wg.Wait()
	})
}
