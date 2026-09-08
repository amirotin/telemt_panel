// Package hub polls Telemt on behalf of every connected client and fans
// out changes over Server-Sent Events. See v2/specs/02-hub-sse.md: one
// poller per topic no matter how many subscribers, the client never picks
// the interval, and a push happens only when the topic's comparison snapshot
// actually changes.
package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

// Default poll intervals and lifecycle timings (spec 02-hub-sse.md). Tests
// override these via Config with millisecond-scale values.
const (
	defaultUsersInterval     = 10 * time.Second
	defaultStatsInterval     = 5 * time.Second
	defaultTrafficInterval   = 30 * time.Second
	defaultRuntimeInterval   = 10 * time.Second
	defaultUpstreamsInterval = 15 * time.Second
	defaultSecurityInterval  = 30 * time.Second
	// defaultWebInterval matches the "runtime" cadence: the WEB status is a
	// process view of the same shape and volume as the runtime group, and
	// the M4 task-8b brief pins it there explicitly.
	defaultWebInterval      = 10 * time.Second
	defaultGrace            = 30 * time.Second
	defaultHeartbeat        = 25 * time.Second
	defaultSubscriberBuffer = 64
	defaultReplayRingSize   = 256
	defaultReplayMaxBytes   = 8 << 20

	// defaultStatsSysInfoRefresh bounds how often the "stats" topic's poll
	// re-fetches GET /v1/system/info for its version/uptime fields — every
	// 5s stats poll would be wasteful for values that rarely change (spec
	// task brief: "every 12th poll or 60s"). 60s at the default 5s stats
	// interval is exactly the 12th-poll cadence the brief suggests.
	defaultStatsSysInfoRefresh = 60 * time.Second

	// maxBackoff caps the exponential backoff applied to a topic's poll
	// interval while its upstream fetch keeps failing.
	maxBackoff = 60 * time.Second

	// defaultPokeFloor bounds how often Poke can force an extra poll of
	// the same topic beyond its normal interval — see Poke's doc comment.
	defaultPokeFloor = 500 * time.Millisecond

	// recentEventsLimit is the explicit ?limit= the "runtime" topic asks
	// GET /v1/runtime/events/recent for. It matches Telemt's own
	// EVENTS_DEFAULT_LIMIT (runtime_edge.rs) and the volume the live
	// snapshot documents as the real working set — 50 events,
	// TELEMT_LIVE_API_DATA.md §18 / §24 ("50 events" among the minimum
	// prototype cardinalities). Passing it explicitly rather than 0 keeps
	// the panel's payload size fixed even if Telemt's own default moves.
	recentEventsLimit = 50

	// sourceErrorCode is the SSE source_error event's code for any fetch
	// failure; the panel does not currently need finer-grained
	// classification of the underlying Telemt error.
	sourceErrorCode = "telemt_unreachable"

	// History metric names (store.RecordMetric/MetricRange series keys).
	metricConnections = "connections"
	metricActiveUsers = "active_users"
	metricTraffic     = "traffic"
	// metricRefusals and metricAttempts are the monotonic pair counters.go
	// builds out of the summary's cumulative counters: how many clients
	// were turned away in a window, and how many tried. Сводка's «Качество
	// подключений» is one divided by the other, so they must be counted the
	// same way — hence one accumulator type and one recording site.
	metricRefusals = "refusals"
	metricAttempts = "attempts"

	metricRouteMode         = "mode.route"
	metricTelemtAvailable   = "telemt.available"
	metricTelemtUnavailable = "telemt.unavailable"
)

// Config configures the hub's poll intervals and lifecycle timings. Zero
// fields fall back to the production defaults above.
type Config struct {
	UsersInterval     time.Duration
	StatsInterval     time.Duration
	TrafficInterval   time.Duration
	RuntimeInterval   time.Duration
	UpstreamsInterval time.Duration
	SecurityInterval  time.Duration
	WebInterval       time.Duration
	Grace             time.Duration
	Heartbeat         time.Duration
	SubscriberBuffer  int
	ReplayRingSize    int
	ReplayMaxBytes    int
	// StatsSysInfoRefresh overrides defaultStatsSysInfoRefresh; tests set
	// this small to observe the refresh without a real 60s wait.
	StatsSysInfoRefresh time.Duration
	// PokeFloor overrides defaultPokeFloor; tests set this small (or use
	// the injectable Hub.now instead) to observe floor behavior without a
	// real 500ms wait.
	PokeFloor time.Duration
}

func (c Config) withDefaults() Config {
	if c.UsersInterval <= 0 {
		c.UsersInterval = defaultUsersInterval
	}
	if c.StatsInterval <= 0 {
		c.StatsInterval = defaultStatsInterval
	}
	if c.TrafficInterval <= 0 {
		c.TrafficInterval = defaultTrafficInterval
	}
	if c.RuntimeInterval <= 0 {
		c.RuntimeInterval = defaultRuntimeInterval
	}
	if c.UpstreamsInterval <= 0 {
		c.UpstreamsInterval = defaultUpstreamsInterval
	}
	if c.SecurityInterval <= 0 {
		c.SecurityInterval = defaultSecurityInterval
	}
	if c.WebInterval <= 0 {
		c.WebInterval = defaultWebInterval
	}
	if c.Grace <= 0 {
		c.Grace = defaultGrace
	}
	if c.Heartbeat <= 0 {
		c.Heartbeat = defaultHeartbeat
	}
	if c.SubscriberBuffer <= 0 {
		c.SubscriberBuffer = defaultSubscriberBuffer
	}
	if c.ReplayRingSize <= 0 {
		c.ReplayRingSize = defaultReplayRingSize
	}
	if c.ReplayMaxBytes <= 0 {
		c.ReplayMaxBytes = defaultReplayMaxBytes
	}
	if c.StatsSysInfoRefresh <= 0 {
		c.StatsSysInfoRefresh = defaultStatsSysInfoRefresh
	}
	if c.PokeFloor <= 0 {
		c.PokeFloor = defaultPokeFloor
	}
	return c
}

// Event is one item in the hub's global replay ring and in a subscriber's
// stream: either a topic snapshot/update (Data and TS set, Err empty) or a
// fetch-failure notice for the topic (Err set; "source_error" on the wire).
// Seq is a hub-wide monotonic sequence number, used as the SSE id and for
// Last-Event-ID replay.
type Event struct {
	Seq   uint64
	Topic string
	Data  json.RawMessage
	TS    int64
	Err   string
}

// ErrUnknownTopic is returned by Subscribe and Snapshot for a topic name
// the hub does not recognize.
type ErrUnknownTopic struct{ Topic string }

// Error implements error.
func (e *ErrUnknownTopic) Error() string {
	return fmt.Sprintf("unknown topic: %s", e.Topic)
}

// fetchFunc retrieves and normalizes one topic's current data.
type fetchFunc func(ctx context.Context) (any, error)

// usersLiveGauges is the scalar slice of a successful users observation that
// stats history may reuse while it is fresh.
type usersLiveGauges struct {
	connections uint64
	activeUsers int
}

func (g *usersLiveGauges) addUser(currentConnections uint64) {
	g.connections += currentConnections
	if currentConnections > 0 {
		g.activeUsers++
	}
}

// topicState is one topic's poller lifecycle and cache, guarded by Hub.mu.
type topicState struct {
	name     string
	interval time.Duration
	fetch    fetchFunc
	// historyFetch collects only inputs required by history/live gauges.
	// It is selected by the existing poller when no UI subscriber needs a
	// full projection; history-only results are never marshalled or published.
	historyFetch fetchFunc
	pollGate     chan struct{}
	// persistent keeps a collector alive without subscribers. Durable
	// stores use this for technical history; volatile stores preserve the
	// demand-driven router profile.
	persistent bool

	subCount   int
	running    bool
	stop       chan struct{}
	graceTimer *time.Timer

	hasData     bool
	fullFresh   bool
	fullVersion uint64
	// fullPending is subscriber hydration demand that must survive an
	// in-flight history poll and bypass the ordinary Poke floor.
	fullPending bool
	// pokePending is kept separately so completing hydration cannot consume
	// a mutation-triggered refresh that arrived while the full fetch ran.
	pokePending bool
	lastData    json.RawMessage
	lastKey     json.RawMessage
	lastEvent   Event
	// lastObservedAt tracks successful full polls and minimal users gauge
	// observations even when push-on-change skips a broadcast. A failed
	// relevant poll clears it without removing the UI cache.
	lastObservedAt time.Time
	usersGauges    usersLiveGauges
	usersGaugesOK  bool

	// wake carries hydration and Poke requests to runPoller: a buffered(1),
	// non-blocking signal. Explicit flags preserve the two kinds of demand
	// while redundant signals coalesce. nil for push-only topics.
	wake chan struct{}
	// lastForcedPollAt is touched only by runPoller's own goroutine (never
	// read or written under Hub.mu, never from Poke) — safe without a lock
	// by construction, the same way runPoller's local backoff/timer
	// variables are. Zero value means "never forced yet".
	lastForcedPollAt time.Time
}

// subscriber is one client's view of the hub: a buffered event channel and
// the set of topics it wants. closed guards against closing ch twice (the
// slow-consumer path in broadcastLocked and the caller's cancel func can
// both try).
type subscriber struct {
	id     uint64
	ch     chan Event
	topics map[string]struct{}
	closed bool
}

// Hub polls Telemt for the registered topics and fans out changes to
// subscribers. Call Close when done to stop every poller.
type Hub struct {
	ips userIPCollector
	cfg Config
	st  store.HistoryStore
	tc  *telemt.Client

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	mu          sync.Mutex
	topics      map[string]*topicState
	subscribers map[uint64]*subscriber
	nextSubID   uint64
	seq         uint64
	ring        []Event
	ringBytes   int

	// refusals/attempts hold the running totals behind those two history
	// series across polls (counters.go) — their own locks, since
	// recordStatsHistory runs outside h.mu.
	refusals       counterAccumulator
	attempts       counterAccumulator
	transitions    historyTransitionState
	trafficStarted bool

	// historyRecordedHook, if set, runs synchronously in pollWithContext
	// immediately after every recordStatsHistory call (whether or not that
	// call actually wrote a point — see recordStatsHistory's own degrade
	// rules) — nil in production. Test-only: lets a test wait for "a stats
	// poll's history recording just ran" deterministically instead of
	// polling the store with a sleep loop.
	historyRecordedHook func()

	// now is Poke's injectable clock for its floor check (defaultPokeFloor/
	// Config.PokeFloor) — defaults to time.Now; tests substitute a fake to
	// observe floor behavior without a real wait.
	now func() time.Time
	// scheduleTimer is PokeAfter's injectable one-shot scheduler — same
	// signature and default (time.AfterFunc) as store.Memory's own
	// scheduleTimer field; tests substitute a fake that fires synchronously
	// or on manual trigger instead of waiting the real delay.
	scheduleTimer func(d time.Duration, f func()) (stop func())
}

// New creates a Hub polling tc for this package's topic registry. Call
// StartPersistentCollectors after construction to start background history.
// Topic polling remains demand-driven for memory stores; the bounded traffic
// collector is the intentional exception because its baseline must stay warm.
func New(cfg Config, tc *telemt.Client, st store.HistoryStore) *Hub {
	cfg = cfg.withDefaults()
	ctx, cancel := context.WithCancel(context.Background())
	h := &Hub{
		cfg:         cfg,
		st:          st,
		tc:          tc,
		ctx:         ctx,
		cancel:      cancel,
		subscribers: make(map[uint64]*subscriber),
		now:         time.Now,
		scheduleTimer: func(d time.Duration, f func()) func() {
			t := time.AfterFunc(d, f)
			return func() { t.Stop() }
		},
	}
	sysInfo := &statsSysInfoRefresher{tc: tc, interval: cfg.StatsSysInfoRefresh, now: time.Now}
	durableHistory := st != nil && st.Info().Durable
	h.topics = map[string]*topicState{
		"users": {
			name:         "users",
			wake:         make(chan struct{}, 1),
			interval:     cfg.UsersInterval,
			fetch:        func(ctx context.Context) (any, error) { return fetchUsers(ctx, tc, st) },
			historyFetch: func(ctx context.Context) (any, error) { return fetchUsersHistory(ctx, tc) },
			pollGate:     newTopicGate(),
			persistent:   durableHistory,
		},
		"stats": {
			name:         "stats",
			wake:         make(chan struct{}, 1),
			interval:     cfg.StatsInterval,
			fetch:        func(ctx context.Context) (any, error) { return fetchStats(ctx, tc, sysInfo) },
			historyFetch: func(ctx context.Context) (any, error) { return fetchStatsHistory(ctx, tc) },
			pollGate:     newTopicGate(),
			persistent:   durableHistory,
		},
		"runtime": {
			name:         "runtime",
			wake:         make(chan struct{}, 1),
			interval:     cfg.RuntimeInterval,
			fetch:        func(ctx context.Context) (any, error) { return fetchRuntime(ctx, tc) },
			historyFetch: func(ctx context.Context) (any, error) { return fetchRuntimeHistory(ctx, tc) },
			pollGate:     newTopicGate(),
			persistent:   durableHistory,
		},
		"upstreams": {
			name:         "upstreams",
			wake:         make(chan struct{}, 1),
			interval:     cfg.UpstreamsInterval,
			fetch:        func(ctx context.Context) (any, error) { return fetchUpstreams(ctx, tc) },
			historyFetch: func(ctx context.Context) (any, error) { return fetchUpstreamsHistory(ctx, tc) },
			pollGate:     newTopicGate(),
			persistent:   durableHistory,
		},
		"security": {
			name:     "security",
			wake:     make(chan struct{}, 1),
			interval: cfg.SecurityInterval,
			fetch:    func(ctx context.Context) (any, error) { return fetchSecurity(ctx, tc) },
			pollGate: newTopicGate(),
		},
		"web": {
			name:     "web",
			wake:     make(chan struct{}, 1),
			interval: cfg.WebInterval,
			fetch:    func(ctx context.Context) (any, error) { return fetchWeb(ctx, tc) },
			pollGate: newTopicGate(),
		},
		// "update" is event-driven, not polled: the update engine and
		// auto-updater push snapshots into it directly via PublishUpdate.
		// A nil fetch is this topic's marker — Subscribe/Snapshot special-case
		// it below instead of ever calling a poller.
		"update": {
			name: "update",
		},
	}
	return h
}

// usersSnapshot is the "users" topic's composite payload (spec
// 02-hub-sse.md topic table: "список пользователей + квоты"): the raw
// Telemt user list merged with quota usage, mirroring the same graceful
// degradation httpapi's quotaListOrDegrade applies to the REST endpoint —
// a quota fetch failure never fails the topic, it just publishes without
// quota data. Quota is an explicit JSON null (Go's nil-map default), not an
// omitted key, when the capability is unsupported or the probe failed.
type usersSnapshot struct {
	Users          []userSnapshotItem           `json:"users"`
	Quota          map[string]telemt.QuotaEntry `json:"quota"`
	QuotaSupported bool                         `json:"quota_supported"`
	liveGauges     usersLiveGauges
	liveGaugesOK   bool
}

type userSnapshotItem struct {
	telemt.UserInfo
	IPHistory *store.UserIPSummary `json:"ip_history,omitempty"`
	Traffic   *userTrafficSnapshot `json:"traffic,omitempty"`
}

type userTrafficSnapshot struct {
	ObservedTotalBytes     int64                       `json:"observed_total_bytes"`
	CurrentMonthBytes      int64                       `json:"current_month_bytes"`
	MonthKey               int                         `json:"month_key"`
	ObservedSinceEpochSecs int64                       `json:"observed_since_epoch_secs"`
	LastActivityEpochSecs  int64                       `json:"last_activity_epoch_secs"`
	Continuity             store.UserTrafficContinuity `json:"continuity"`
}

func fetchUsers(ctx context.Context, tc *telemt.Client, st store.HistoryStore) (usersSnapshot, error) {
	users, gauges, err := fetchUsersObservation(ctx, tc)
	if err != nil {
		return usersSnapshot{}, err
	}
	// Both calls run under the poll's own context/timeout — a quota hiccup
	// must not cost the users topic its own budget twice.
	quota, hasQuota, err := tc.QuotaList(ctx)
	if err != nil {
		slog.Warn("hub: users topic: quota list", "err", err)
		quota, hasQuota = nil, false
	}
	var traffic map[string]store.UserTrafficSummary
	if st != nil {
		traffic, err = st.UserTrafficSummaries()
		if err != nil {
			slog.Warn("hub: users topic: traffic summaries", "err", err)
			traffic = nil
		}
	}
	var ips map[string]store.UserIPSummary
	if st != nil {
		ips, err = store.UserIPSummaryMap(st, time.Now().Unix())
		if err != nil {
			slog.Warn("hub: IP summaries unavailable")
		}
	}
	items := make([]userSnapshotItem, len(users))
	for i, user := range users {
		items[i].UserInfo = user
		if summary, ok := ips[user.Username]; ok {
			items[i].IPHistory = &summary
		}
		if summary, ok := traffic[user.Username]; ok {
			items[i].Traffic = &userTrafficSnapshot{
				ObservedTotalBytes: summary.ObservedTotalBytes, CurrentMonthBytes: summary.CurrentMonthBytes,
				MonthKey: summary.MonthKey, ObservedSinceEpochSecs: summary.ObservedSinceEpochSecs,
				LastActivityEpochSecs: summary.LastActivityEpochSecs, Continuity: summary.Continuity,
			}
		}
	}
	return usersSnapshot{
		Users: items, Quota: quota, QuotaSupported: hasQuota,
		liveGauges: gauges, liveGaugesOK: true,
	}, nil
}

// statsSnapshot is the "stats" topic's composite payload (spec
// 02-hub-sse.md topic table, extended per M3 task-2's brief): Health,
// StatsSummary and Ready are fetched independently, any of them may be
// null if its sub-call failed — the topic still publishes as long as at
// least one succeeds. ConnectionsSummary is included only when the
// runtime_edge capability is on (its own Gated[T] wrapper already reports
// "disabled" cleanly, but the brief scopes this field to when the capability
// is actually available, to avoid every stats tick paying for and shipping
// an always-closed gate object on a stock config). Version/UptimeSeconds
// come from GET /v1/system/info, refreshed at most every
// Config.StatsSysInfoRefresh (see statsSysInfoRefresher) rather than every
// poll.
type statsSnapshot struct {
	Health             *telemt.HealthData                                         `json:"health"`
	Summary            *telemt.SummaryData                                        `json:"summary"`
	Ready              *telemt.ReadyData                                          `json:"ready"`
	ConnectionsSummary *telemt.Gated[telemt.RuntimeEdgeConnectionsSummaryPayload] `json:"connections_summary,omitempty"`
	Version            string                                                     `json:"version,omitempty"`
	UptimeSeconds      float64                                                    `json:"uptime_seconds,omitempty"`
	// The config-reload pair of GET /v1/system/info, for Сводка's status
	// banner ("последняя перезагрузка конфига"). The count is omitted at
	// zero (no reload has happened yet) and the timestamp is a pointer
	// because Telemt only sends it once one has — an absent key stays
	// distinguishable from a real 0.
	ConfigReloadCount         uint64 `json:"config_reload_count,omitempty"`
	LastConfigReloadEpochSecs *int64 `json:"last_config_reload_epoch_secs,omitempty"`
}

func fetchStats(ctx context.Context, tc *telemt.Client, sysInfo *statsSysInfoRefresher) (statsSnapshot, error) {
	snap, err := fetchStatsHistory(ctx, tc)
	if err != nil {
		return statsSnapshot{}, err
	}

	if info, ok := sysInfo.get(ctx); ok {
		snap.Version = info.version
		snap.UptimeSeconds = info.uptime
		snap.ConfigReloadCount = info.configReloadCount
		snap.LastConfigReloadEpochSecs = info.lastConfigReload
	}

	return snap, nil
}

// statsSysInfoRefresher rate-limits GET /v1/system/info fetches inside the
// "stats" topic's poll loop: version/uptime rarely change, so calling
// SystemInfo on every 5s poll would be wasteful. Safe for concurrent use —
// the poll loop and an on-demand Snapshot fetch can both call get.
type statsSysInfoRefresher struct {
	tc       *telemt.Client
	interval time.Duration
	now      func() time.Time

	mu      sync.Mutex
	lastAt  time.Time
	cached  sysInfoView
	hasData bool
}

// sysInfoView is the slice of GET /v1/system/info the "stats" topic
// republishes — version and uptime for the status banner's facts, plus the
// config-reload pair behind its «последняя перезагрузка конфига» line.
type sysInfoView struct {
	version           string
	uptime            float64
	configReloadCount uint64
	lastConfigReload  *int64
}

// get returns the cached version/uptime if still fresh, otherwise re-fetches
// GET /v1/system/info. ok is false only when there is neither a fresh nor a
// stale cached value AND the fetch itself failed — the stats topic then
// simply omits Version/UptimeSeconds for this tick rather than blocking on
// it or failing the whole poll.
func (r *statsSysInfoRefresher) get(ctx context.Context) (view sysInfoView, ok bool) {
	r.mu.Lock()
	if r.hasData && r.now().Sub(r.lastAt) < r.interval {
		view = r.cached
		r.mu.Unlock()
		return view, true
	}
	r.mu.Unlock()

	info, err := r.tc.SystemInfo(ctx)
	if err != nil {
		r.mu.Lock()
		view, ok = r.cached, r.hasData
		r.mu.Unlock()
		return view, ok
	}

	r.mu.Lock()
	r.cached = sysInfoView{
		version:           info.Version,
		uptime:            info.UptimeSeconds,
		configReloadCount: info.ConfigReloadCount,
		lastConfigReload:  info.LastConfigReloadEpochSecs,
	}
	r.hasData, r.lastAt = true, r.now()
	view = r.cached
	r.mu.Unlock()
	return view, true
}

// runtimeSnapshot is the "runtime" topic's composite payload (spec
// 02-hub-sse.md / M3 task-2 brief, extended by mini-task 2c): the
// always-on Gates/Initialization group plus the ME-pool/quality/NAT-STUN/
// self-test Gated[T] group. Any sub-call failing leaves its field null and
// the topic still publishes; every one of the six original (Gates through
// MeSelfTest) failing is treated as Telemt being unreachable — Minimal and
// UpstreamQuality are additional best-effort fields (mini-task 2c) whose
// own failure never counts toward that check, the same treatment
// RecentEvents already gets, just without the runtime_edge gate (Minimal/
// UpstreamQuality are gated by minimal_runtime_enabled instead, which
// their own response's enabled/reason fields already report — see
// MinimalAllPayload/RuntimeUpstreamQualityData's doc comments — so unlike
// RecentEvents they're always attempted, not conditioned on a
// Capabilities() probe). RecentEvents itself is included only when the
// runtime_edge capability is on.
type runtimeSnapshot struct {
	Gates           *telemt.RuntimeGatesData                        `json:"gates"`
	Initialization  *telemt.RuntimeInitializationData               `json:"initialization"`
	MePoolState     *telemt.Gated[telemt.RuntimeMePoolStatePayload] `json:"me_pool_state"`
	MeQuality       *telemt.Gated[telemt.RuntimeMeQualityPayload]   `json:"me_quality"`
	NatStun         *telemt.Gated[telemt.RuntimeNatStunPayload]     `json:"nat_stun"`
	MeSelfTest      *telemt.Gated[telemt.RuntimeMeSelftestPayload]  `json:"me_selftest"`
	Minimal         *telemt.Gated[telemt.MinimalAllPayload]         `json:"minimal"`
	UpstreamQuality *telemt.RuntimeUpstreamQualityData              `json:"upstream_quality"`
	RecentEvents    *telemt.Gated[telemt.RuntimeEdgeEventsPayload]  `json:"recent_events,omitempty"`
}

func fetchRuntime(ctx context.Context, tc *telemt.Client) (runtimeSnapshot, error) {
	history := collectRuntimeHistoryInputs(ctx, tc)
	snap := history.snapshot
	var errs []error

	if history.gatesErr != nil {
		errs = append(errs, history.gatesErr)
	}
	if v, err := tc.Initialization(ctx); err == nil {
		snap.Initialization = &v
	} else {
		errs = append(errs, err)
	}
	if v, err := tc.MePoolState(ctx); err == nil {
		snap.MePoolState = &v
	} else {
		errs = append(errs, err)
	}
	if v, err := tc.MeQuality(ctx); err == nil {
		snap.MeQuality = &v
	} else {
		errs = append(errs, err)
	}
	if v, err := tc.NatStun(ctx); err == nil {
		snap.NatStun = &v
	} else {
		errs = append(errs, err)
	}
	if v, err := tc.MeSelfTest(ctx); err == nil {
		snap.MeSelfTest = &v
	} else {
		errs = append(errs, err)
	}
	if len(errs) == 6 {
		return runtimeSnapshot{}, fmt.Errorf("runtime: %w", errors.Join(errs...))
	}

	// Minimal/UpstreamQuality: always attempted (gated by
	// minimal_runtime_enabled, reflected in their own response, not by a
	// capability probe here) — a failure is logged and leaves the field
	// null, same degrade rule as every other sub-call, but never joins
	// errs above: mini-task 2c scopes these two as best-effort additions
	// that must not turn a healthy six-call poll into a source_error.
	if v, err := tc.MinimalAll(ctx); err == nil {
		snap.Minimal = &v
	} else {
		slog.Warn("hub: runtime topic: minimal all", "err", err)
	}
	if history.qualityErr != nil {
		slog.Warn("hub: runtime topic: upstream quality", "err", history.qualityErr)
	}

	if caps, err := tc.Capabilities(ctx); err == nil && caps.RuntimeEdge {
		if v, err := tc.RecentEvents(ctx, recentEventsLimit); err == nil {
			snap.RecentEvents = &v
		} else {
			slog.Warn("hub: runtime topic: recent events", "err", err)
		}
	}

	return snap, nil
}

// upstreamsSnapshot is the "upstreams" topic's composite payload: Upstreams
// + DCs + MeWriters (spec 02-hub-sse.md / M3 task-2 brief). Any one failing
// leaves its field null and the topic still publishes; all three failing is
// treated as Telemt being unreachable.
type upstreamsSnapshot struct {
	Upstreams *telemt.UpstreamsData `json:"upstreams"`
	DCs       *telemt.DcStatusData  `json:"dcs"`
	MeWriters *telemt.MeWritersData `json:"me_writers"`
}

func fetchUpstreams(ctx context.Context, tc *telemt.Client) (upstreamsSnapshot, error) {
	var snap upstreamsSnapshot
	var upstreamsErr, dcsErr, meWritersErr error

	if v, err := tc.Upstreams(ctx); err == nil {
		snap.Upstreams = &v
	} else {
		upstreamsErr = err
	}
	if history, err := fetchUpstreamsHistory(ctx, tc); err == nil {
		snap.DCs = history.DCs
	} else {
		dcsErr = err
	}
	if v, err := tc.MeWriters(ctx); err == nil {
		snap.MeWriters = &v
	} else {
		meWritersErr = err
	}
	if upstreamsErr != nil && dcsErr != nil && meWritersErr != nil {
		return upstreamsSnapshot{}, fmt.Errorf("upstreams: %w", errors.Join(upstreamsErr, dcsErr, meWritersErr))
	}
	return snap, nil
}

// securitySnapshot is the "security" topic's composite payload: Posture +
// Whitelist + EffectiveLimits (spec 02-hub-sse.md / M3 task-2 brief). Any
// one failing leaves its field null and the topic still publishes; all
// three failing is treated as Telemt being unreachable.
//
// TLS fingerprints deliberately do NOT belong here: the live payload is
// ~120 KB / 1957 leaves per poll (TELEMT_LIVE_API_DATA.md §19), by far the
// largest single endpoint, for data no dashboard needs every 30s. The
// owner's 2026-08-26 ruling makes it fetch-on-visit instead — GET
// /api/telemt/tls-fingerprints (telemt_tls_handler.go), which the widget
// and the Security details page poll at their own cadence.
type securitySnapshot struct {
	Posture         *telemt.SecurityPostureData   `json:"posture"`
	Whitelist       *telemt.SecurityWhitelistData `json:"whitelist"`
	EffectiveLimits *telemt.EffectiveLimitsData   `json:"effective_limits"`
}

func fetchSecurity(ctx context.Context, tc *telemt.Client) (securitySnapshot, error) {
	var snap securitySnapshot
	var postureErr, whitelistErr, limitsErr error

	if v, err := tc.Posture(ctx); err == nil {
		snap.Posture = &v
	} else {
		postureErr = err
	}
	if v, err := tc.Whitelist(ctx); err == nil {
		snap.Whitelist = &v
	} else {
		whitelistErr = err
	}
	if v, err := tc.EffectiveLimits(ctx); err == nil {
		snap.EffectiveLimits = &v
	} else {
		limitsErr = err
	}
	if postureErr != nil && whitelistErr != nil && limitsErr != nil {
		return securitySnapshot{}, fmt.Errorf("security: %w", errors.Join(postureErr, whitelistErr, limitsErr))
	}

	return snap, nil
}

// webSnapshot is the "web" topic's payload: the WEB runtime status behind
// the same Gated[T] envelope the edge topics use.
//
// Telemt's own GET /v1/runtime/web/status is NOT gated — it answers 200 even
// with WEB off, reporting the closure through `available`/`reason`
// (api/web_runtime.rs). The wrapper is built here instead, for one reason:
// the browser already has ONE way to render "this source is closed, here is
// why" (caps/Gated + details-builder/sources.ts), and the alternative was a
// second, WEB-only convention in the frontend for the same three states.
//
// Data is filled in even while the gate is closed: `lifecycle`, `listeners`
// and `effective_config_enabled` are exactly what an operator needs to see
// to understand WHY it is closed, and dropping them would make the page
// emptier the moment it matters most.
type webSnapshot struct {
	Status *telemt.Gated[telemt.WebStatusData] `json:"status"`
}

// webGateReasonUnsupported is the reason token the panel puts on the gate
// when the route itself is missing. It is the panel's own vocabulary, not
// Telemt's: details-builder/sources.ts reads it as `unsupported` (rule R5),
// which is what makes the card offer "update Telemt" instead of "flip a
// setting your binary does not have".
const webGateReasonUnsupported = "capability_absent"

func fetchWeb(ctx context.Context, tc *telemt.Client) (webSnapshot, error) {
	status, err := tc.WebStatus(ctx)
	switch {
	case err == nil:
		gated := telemt.Gated[telemt.WebStatusData]{
			Enabled: status.Available,
			Reason:  status.Reason,
			Data:    &status,
		}
		return webSnapshot{Status: &gated}, nil
	case telemt.IsWebRouteAbsent(err):
		// Telemt < 3.5.3 does not register /v1/runtime/web/* at all. Not an
		// error: an old build is a state the panel renders, not a failure.
		return webSnapshot{Status: &telemt.Gated[telemt.WebStatusData]{Reason: webGateReasonUnsupported}}, nil
	case telemt.IsWebRuntimeUnavailable(err):
		// Defensive: the status route itself never answers 503 today, but
		// the code is the group's documented "runtime is not running"
		// signal and mapping it to a closed gate keeps the topic honest if
		// a future build starts using it here too.
		return webSnapshot{Status: &telemt.Gated[telemt.WebStatusData]{Reason: telemt.CodeWebRuntimeUnavailable}}, nil
	default:
		return webSnapshot{}, fmt.Errorf("web: %w", err)
	}
}

// recordStatsHistory appends one point to each history metric series
// This records the global technical series derived from a just-fetched
// "stats" topic snapshot. A metric
// this tick can't derive — no runtime_edge and the "users" topic hasn't
// been polled yet — is simply skipped for this tick rather than recording
// a misleading value; GET /api/history degrades to fewer points, never an
// error. Documented choice of source field per metric:
//   - connections/active_users: the runtime-edge ConnectionsSummary's live
//     Totals when available; otherwise exact totals derived from the cached
//     users snapshot. Lifetime ConnectionsTotal and ConfiguredUsers are never
//     used as live gauges.
//   - refusals/attempts: the monotonic running totals counterAccumulator
//     folds out of StatsSummary's cumulative failure and connection counters
//     (counters.go) — skipped entirely when the summary sub-call failed this
//     tick, since the accumulator must not mistake a missing sample for a
//     counter reset.
//
// User traffic has its own coherent collector. It must not combine this
// topic's cached users with a separately sampled uptime.
func (h *Hub) recordStatsHistory(snap statsSnapshot) {
	if h.st == nil {
		return
	}
	ts := time.Now().Unix()
	batch := make([]store.NamedMetricPoint, 0, 6)
	add := func(name string, value float64) {
		batch = append(batch, store.NamedMetricPoint{Name: name, Point: store.MetricPoint{TS: ts, Value: value}})
	}
	add(metricTelemtAvailable, 1)
	add(metricTelemtUnavailable, 0)

	usersGauges, hasUsersGauges := h.cachedUsersLiveGauges()
	switch {
	case snap.ConnectionsSummary != nil && snap.ConnectionsSummary.Enabled && snap.ConnectionsSummary.Data != nil:
		totals := snap.ConnectionsSummary.Data.Totals
		add(metricConnections, float64(totals.CurrentConnections))
		add(metricActiveUsers, float64(totals.ActiveUsers))
	case hasUsersGauges:
		add(metricConnections, float64(usersGauges.connections))
		add(metricActiveUsers, float64(usersGauges.activeUsers))
	}

	if snap.Summary != nil {
		uptime := snap.Summary.UptimeSeconds
		add(metricRefusals, float64(h.refusals.observe(refusalsTotal(snap.Summary), uptime)))
		add(metricAttempts, float64(h.attempts.observe(snap.Summary.ConnectionsTotal, uptime)))
	}
	if err := h.st.RecordMetrics(batch); err != nil {
		slog.Warn("hub: record metrics", "count", len(batch), "err", err)
	}
}

// cachedUsersLiveGauges supplies history fallback gauges only from a fresh
// successful poll. The UI may retain old data during an outage; history must
// not turn it into new observations. Allow two poll intervals for scheduling
// skew.
func (h *Hub) cachedUsersLiveGauges() (usersLiveGauges, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	t := h.topics["users"]
	if t == nil || !t.usersGaugesOK || t.lastObservedAt.IsZero() || h.now().Sub(t.lastObservedAt) > 2*t.interval {
		return usersLiveGauges{}, false
	}
	return t.usersGauges, true
}

func usersLiveTotals(users []userSnapshotItem) usersLiveGauges {
	var gauges usersLiveGauges
	for _, user := range users {
		gauges.addUser(user.CurrentConnections)
	}
	return gauges
}

// HistoryRetention returns the active store's actual reach. Durable stores use
// the category policy; memory uses its bounded raw ring at the configured stats
// cadence. GET /api/history publishes the same distinction as retention_secs.
func (h *Hub) HistoryRetention() time.Duration {
	if h.st != nil && h.st.Info().Durable {
		return h.st.MetricRetention(metricConnections)
	}
	return min(store.LiveMetricRetention, time.Duration(store.MetricCap-1)*h.cfg.StatsInterval)
}

// StartPersistentCollectors starts every topic marked for background history
// collection and the independent traffic collector. Traffic totals remain
// useful in the bounded memory profile, so that collector is not conditional
// on durable storage.
func (h *Hub) StartPersistentCollectors() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.tc != nil && h.st != nil {
		h.topics["users"].persistent = true
	}
	if !h.trafficStarted && h.tc != nil && h.st != nil {
		h.trafficStarted = true
		h.wg.Add(1)
		go h.runTrafficCollector()
	}
	for _, topic := range h.topics {
		if !topic.persistent || topic.running || topic.fetch == nil {
			continue
		}
		topic.running = true
		topic.stop = make(chan struct{})
		h.wg.Add(1)
		go h.runPoller(topic)
	}
}

func (h *Hub) runTrafficCollector() {
	defer h.wg.Done()
	backoff := h.cfg.TrafficInterval
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-h.ctx.Done():
			return
		case <-timer.C:
			if h.collectUserTraffic(h.ctx) {
				backoff = h.cfg.TrafficInterval
			} else {
				backoff *= 2
				if backoff > maxBackoff {
					backoff = maxBackoff
				}
			}
			timer.Reset(backoff)
		}
	}
}

func (h *Hub) collectUserTraffic(ctx context.Context) bool {
	snapshot, err := h.tc.TrafficSnapshot(ctx)
	if err != nil {
		slog.Warn("hub: collect user traffic snapshot", "err", err)
		return false
	}
	users := make([]store.UserTrafficObservation, len(snapshot.Users))
	for i, user := range snapshot.Users {
		users[i] = store.UserTrafficObservation{Username: user.Username, RawOctets: user.TotalOctets}
	}
	_, err = h.st.ApplyUserTrafficSnapshot(store.UserTrafficSnapshot{
		ObservedAt:       snapshot.ObservedAt,
		SourceStartedAt:  snapshot.SourceStartedAt,
		TelemetryEnabled: snapshot.TelemetryEnabled,
		Users:            users,
	})
	if err != nil {
		slog.Warn("hub: apply user traffic snapshot", "users", len(users), "err", err)
		return false
	}

	// Keep the existing aggregate chart compatible while exact per-user
	// accounting remains integer-only in the dedicated store tables.
	summaries, err := h.st.UserTrafficSummaries()
	if err != nil {
		slog.Warn("hub: read user traffic totals", "err", err)
		return true
	}
	var total int64
	for _, summary := range summaries {
		if summary.ObservedTotalBytes > 0 && total > int64(^uint64(0)>>1)-summary.ObservedTotalBytes {
			slog.Warn("hub: aggregate user traffic exceeds int64")
			return true
		}
		total += summary.ObservedTotalBytes
	}
	if err := h.st.RecordMetric(metricTraffic, store.MetricPoint{TS: snapshot.ObservedAt, Value: float64(total)}); err != nil {
		slog.Warn("hub: record aggregate user traffic", "err", err)
	}
	return true
}

// HeartbeatInterval returns the configured SSE heartbeat period.
func (h *Hub) HeartbeatInterval() time.Duration {
	return h.cfg.Heartbeat
}

// Subscribe registers a new subscriber for topics, starting each topic's
// poller if it isn't already running (canceling any pending grace-period
// stop). It returns the subscriber's event channel, the current cached
// snapshot for every requested topic that already has one, and a cancel
// func the caller must call exactly once to unsubscribe. Requesting an
// unknown topic returns *ErrUnknownTopic and registers nothing.
func (h *Hub) Subscribe(topics []string) (ch <-chan Event, snapshots []Event, cancel func(), err error) {
	if len(topics) == 0 {
		return nil, nil, nil, fmt.Errorf("no topics requested")
	}

	h.mu.Lock()
	for _, name := range topics {
		if _, ok := h.topics[name]; !ok {
			h.mu.Unlock()
			return nil, nil, nil, &ErrUnknownTopic{Topic: name}
		}
	}

	sub := &subscriber{
		id:     h.nextSubID,
		ch:     make(chan Event, h.cfg.SubscriberBuffer),
		topics: make(map[string]struct{}, len(topics)),
	}
	h.nextSubID++
	h.subscribers[sub.id] = sub

	for _, name := range topics {
		if _, dup := sub.topics[name]; dup {
			continue
		}
		sub.topics[name] = struct{}{}

		t := h.topics[name]
		firstSubscriber := t.subCount == 0
		t.subCount++
		if t.graceTimer != nil {
			t.graceTimer.Stop()
			t.graceTimer = nil
		}
		// A nil fetch marks a push-only topic (see New's "update" entry):
		// there is nothing to poll, so no poller ever starts for it — its
		// snapshot only ever changes via PublishUpdate.
		wasRunning := t.running
		if !wasRunning && t.fetch != nil {
			t.running = true
			t.stop = make(chan struct{})
			h.wg.Add(1)
			go h.runPoller(t)
		}
		if firstSubscriber && t.historyFetch != nil {
			t.fullFresh = false
			t.fullPending = true
			if wasRunning {
				select {
				case t.wake <- struct{}{}:
				default:
				}
			}
		}
		if t.hasData {
			snapshots = append(snapshots, t.lastEvent)
		}
	}
	h.mu.Unlock()

	id := sub.id
	return sub.ch, snapshots, func() { h.unsubscribe(id) }, nil
}

func (h *Hub) unsubscribe(id uint64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	sub, ok := h.subscribers[id]
	if !ok {
		return
	}
	h.closeSubscriberLocked(id, sub)
}

// closeSubscriberLocked closes sub's channel and drops it from every topic
// it was subscribed to, scheduling that topic's poller to stop after grace
// once its subscriber count reaches zero. Idempotent: safe whether it runs
// from the slow-consumer path in broadcastLocked or from the caller's
// cancel func, whichever happens first.
func (h *Hub) closeSubscriberLocked(id uint64, sub *subscriber) {
	if sub.closed {
		return
	}
	sub.closed = true
	close(sub.ch)
	delete(h.subscribers, id)

	for name := range sub.topics {
		t := h.topics[name]
		t.subCount--
		if t.subCount == 0 && t.historyFetch != nil {
			t.fullFresh = false
			t.fullPending = false
		}
		if t.subCount == 0 && !t.persistent && t.graceTimer == nil {
			t.graceTimer = time.AfterFunc(h.cfg.Grace, func() { h.stopIfIdle(t) })
		}
	}
}

func (h *Hub) stopIfIdle(t *topicState) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if t.subCount != 0 || t.persistent || !t.running {
		return
	}
	close(t.stop)
	t.running = false
	t.graceTimer = nil
}

// runPoller owns one topic's poll loop from start (first subscriber) to
// stop (grace-period timeout after the last unsubscribe, or Close). It
// polls immediately on start so a first subscriber never waits a full
// interval for its snapshot, then on t.interval, doubling the wait on
// fetch errors up to maxBackoff and resetting it on the next success. A
// Hydration/Poke-triggered wake (t.wake) is handled like a normal timer tick.
// Poke remains subject to the floor (t.lastForcedPollAt, touched only here —
// see topicState's doc comment), while first-subscriber hydration bypasses it.
// Direct Snapshot/Poke callers share the topic's context-aware gate with this
// goroutine, so observation and publication for one topic remain serialized.
func (h *Hub) runPoller(t *topicState) {
	defer h.wg.Done()

	stop := t.stop
	backoff := t.interval
	timer := time.NewTimer(0)
	defer timer.Stop()

	// resetTimer restarts the interval timer from now, draining a pending
	// (already-fired but unread) tick first if there is one — both
	// select cases below just polled, so the next one is a full interval
	// (or backoff) away regardless of which case triggered this poll.
	resetTimer := func(d time.Duration) {
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(d)
	}

	for {
		select {
		case <-stop:
			return
		case <-timer.C:
			if h.pollPeriodic(t) {
				backoff = t.interval
			} else {
				backoff *= 2
				if backoff > maxBackoff {
					backoff = maxBackoff
				}
			}
			resetTimer(backoff)
		case <-t.wake:
			h.mu.Lock()
			hydration := t.fullPending
			poke := t.pokePending
			version := t.fullVersion
			if !hydration && !poke {
				h.mu.Unlock()
				continue
			}
			if !hydration && h.now().Sub(t.lastForcedPollAt) < h.cfg.PokeFloor {
				t.pokePending = false
				h.mu.Unlock()
				continue
			}
			if poke {
				t.pokePending = false
			}
			h.mu.Unlock()
			if !hydration {
				t.lastForcedPollAt = h.now()
			}
			recheck := recheckNone
			if hydration && !poke {
				recheck = recheckHydration
			}
			if h.pollWithProfile(h.ctx, t, pollFull, recheck, version) {
				backoff = t.interval
			} else {
				backoff *= 2
				if backoff > maxBackoff {
					backoff = maxBackoff
				}
			}
			// Keep the scheduled users observation independent of manual refreshes.
			if t.name != "users" {
				resetTimer(backoff)
			}
		}
	}
}

// poll runs one background fetch for t, bound to the hub's lifetime
// context. It reports whether the fetch succeeded, for the poller's
// backoff decision.
func (h *Hub) poll(t *topicState) bool {
	return h.pollWithContext(h.ctx, t)
}

// pollWithContext is poll's on-demand counterpart, used by Snapshot to
// bind a fetch to the caller's request context instead of the hub's
// lifetime one — a slow /api/snapshot request can't outlive its client.
func (h *Hub) pollWithContext(ctx context.Context, t *topicState) bool {
	return h.pollWithProfile(ctx, t, pollFull, recheckNone, 0)
}

func (h *Hub) pollWithProfile(ctx context.Context, t *topicState, profile pollProfile, recheck pollGateRecheck, previousVersion uint64) bool {
	if !acquireTopicGate(ctx, t.pollGate) {
		return false
	}
	defer releaseTopicGate(t.pollGate)

	h.mu.Lock()
	if profile == pollHistory && (t.subCount > 0 || t.fullPending) {
		profile = pollFull
	}
	if profile == pollHistory {
		// Invalidate only after this history poll owns the topic gate. A
		// full fetch that completed while we waited must not make the later
		// minimal observation look like a fresh UI projection.
		t.fullFresh = false
	}
	if recheck == recheckHydration && !t.fullPending {
		h.mu.Unlock()
		return true
	}
	if recheck == recheckSnapshot && t.fullFresh && t.hasData && !t.fullPending && (t.running || t.fullVersion != previousVersion) {
		h.mu.Unlock()
		return true
	}
	h.mu.Unlock()

	fetch := t.fetch
	if profile == pollHistory && t.historyFetch != nil {
		fetch = t.historyFetch
	}
	snapshot, err := fetch(ctx)
	if err != nil {
		// A shutdown or caller deadline canceled the observation, not Telemt.
		if ctx.Err() != nil {
			return false
		}
		if t.name == "stats" {
			h.recordTelemtAvailability(false)
		}
		if profile == pollHistory {
			slog.Warn("hub: history poll failed", "topic", t.name, "err", err)
			if t.name == "users" {
				h.recordUsersObservationError(t)
			}
			return false
		}
		h.recordFetchError(t, err)
		return false
	}
	if t.name == "stats" {
		h.recordTelemtAvailability(true)
	}
	var gauges *usersLiveGauges
	// Typed history projection happens before the single publication marshal;
	// no recorder needs to decode the payload it just helped construct.
	switch snap := snapshot.(type) {
	case usersSnapshot:
		value := snap.liveGauges
		if !snap.liveGaugesOK {
			value = usersLiveTotals(snap.Users)
		}
		gauges = &value
	case usersHistoryObservation:
		h.recordUsersObservation(t, snap.gauges)
	case statsSnapshot:
		h.recordStatsHistory(snap)
		if h.historyRecordedHook != nil {
			h.historyRecordedHook()
		}
	case runtimeSnapshot:
		h.recordRuntimeHistory(snap)
	case upstreamsSnapshot:
		h.recordUpstreamsHistory(snap)
	}
	if profile == pollHistory {
		return true
	}
	data, err := json.Marshal(snapshot)
	if err != nil {
		h.recordFetchError(t, fmt.Errorf("marshal %s snapshot: %w", t.name, err))
		return false
	}
	h.recordFetchSuccess(t, data, gauges)
	return true
}

func (h *Hub) recordUsersObservation(t *topicState, gauges usersLiveGauges) {
	h.mu.Lock()
	defer h.mu.Unlock()
	t.lastObservedAt = h.now()
	t.usersGauges = gauges
	t.usersGaugesOK = true
}

func (h *Hub) recordUsersObservationError(t *topicState) {
	h.mu.Lock()
	defer h.mu.Unlock()
	t.lastObservedAt = time.Time{}
	t.usersGaugesOK = false
}

func (h *Hub) recordFetchSuccess(t *topicState, data json.RawMessage, gauges *usersLiveGauges) {
	key := diffKey(t.name, data)
	h.mu.Lock()
	defer h.mu.Unlock()
	hydrating := t.fullPending
	t.lastObservedAt = h.now()
	t.fullFresh = true
	t.fullPending = false
	t.fullVersion++
	if gauges != nil {
		t.usersGauges = *gauges
		t.usersGaugesOK = true
	}
	if t.hasData && bytes.Equal(t.lastKey, key) {
		// A full fetch can be source-fresh while its normalized comparison
		// key is unchanged. Refresh the cached projection, and publish one
		// fresh event only when satisfying first-subscriber hydration. Ordinary
		// periodic polls retain push-on-change suppression.
		t.lastData = data
		if hydrating {
			ev := Event{Seq: h.nextSeqLocked(), Topic: t.name, Data: data, TS: time.Now().Unix()}
			t.lastEvent = ev
			h.appendRingLocked(ev)
			h.broadcastLocked(ev)
			return
		}
		t.lastEvent.Data = data
		t.lastEvent.TS = time.Now().Unix()
		return
	}
	t.hasData = true
	t.lastData = data
	t.lastKey = key
	ev := Event{Seq: h.nextSeqLocked(), Topic: t.name, Data: data, TS: time.Now().Unix()}
	t.lastEvent = ev
	h.appendRingLocked(ev)
	h.broadcastLocked(ev)
}

// diffKey computes push-on-change's comparison key for a topic's raw
// snapshot. Users snapshots are compared byte-for-byte so their uint64
// counters keep their full precision. For other topics, the key is a copy
// with every "generated_at_epoch_secs" field zeroed wherever it appears in
// the (possibly nested) JSON object. The payload actually cached/broadcast
// to subscribers (t.lastData/ev.Data above) always remains unchanged.
//
// Telemt stamps generated_at_epoch_secs with a fresh wall-clock read
// (SystemTime::now(), Rust source: runtime_min.rs/runtime_edge.rs/
// runtime_selftest.rs/runtime_stats.rs's now_epoch_secs()) on every
// response that isn't served from one of its own short-lived per-endpoint
// caches — independent of whether the underlying data changed at all. The
// hub's poll intervals (10-30s for runtime/upstreams/security, 5s for
// stats) are comparable to or longer than those cache windows, so without
// this normalization, spec 02-hub-sse.md principle #3 ("push only on
// change") would be routinely defeated: nearly every poll of runtime,
// upstreams, security (and stats when runtime_edge is on) would broadcast
// a "changed" event purely because Telemt re-stamped the time, even when
// every other field is byte-identical.
//
// Topics that need timestamp suppression use a single generic JSON walk
// (decode, zero any key literally named "generated_at_epoch_secs" at any
// depth, re-encode) rather than per-fetcher special-casing, since the field
// appears in several different shapes: nested inside Gated[T]'s
// generated_at_epoch_secs, and as a top-level field on the flat
// DcStatusData/MeWritersData/UpstreamsData/SecurityWhitelistData structs.
//
// One topic needs more than that one key, which is why the topic name is a
// parameter: see volatileKeysByTopic.
func diffKey(topic string, data json.RawMessage) json.RawMessage {
	if topic == "users" {
		return data
	}
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		// data just came from this package's own json.Marshal a moment
		// earlier (fetchFunc's return value) — this should be unreachable.
		// Falling back to the raw bytes keeps diffing correct (just not
		// robust to the volatile-timestamp issue) instead of panicking.
		return data
	}
	stripVolatileTimestamps(v, volatileKeysFor(topic))
	normalized, err := json.Marshal(v)
	if err != nil {
		return data
	}
	return normalized
}

// volatileTimestampKey is the JSON field name diffKey strips on every topic
// that uses normalized comparison — see its doc comment. A single named
// constant so every occurrence (Gated[T], the flat stats-group structs) is
// covered by construction
// rather than requiring a matching list to be kept in sync.
const volatileTimestampKey = "generated_at_epoch_secs"

// volatileKeysByTopic adds per-topic clock-derived field names on top of
// volatileTimestampKey. Scoped by topic rather than global because these
// names are generic enough to mean something stable elsewhere, and zeroing
// a meaningful field would make push-on-change MISS a real update.
//
// "web": WebStatusData.lifecycle_age_ms and the learning plane's age_ms are
// both `SystemTime::now() - epoch` re-read per request
// (src/api/web_runtime.rs, src/web/manager/status.rs), so without them a
// poll of an idle WEB runtime would broadcast a "change" every 10 s with
// every other field byte-identical.
var volatileKeysByTopic = map[string][]string{
	"web": {"lifecycle_age_ms", "age_ms"},
}

// volatileKeySets is volatileKeysByTopic resolved once, at init, into the
// set diffKey actually indexes. Built at package scope rather than per call
// because normalized comparison runs on every successful poll of those
// topics, and the poll loop avoids needless allocations.
var volatileKeySets = buildVolatileKeySets()

// defaultVolatileKeys is what a topic with no extra names of its own gets —
// one shared, read-only set rather than a fresh map per poll.
var defaultVolatileKeys = map[string]struct{}{volatileTimestampKey: {}}

func buildVolatileKeySets() map[string]map[string]struct{} {
	sets := make(map[string]map[string]struct{}, len(volatileKeysByTopic))
	for topic, names := range volatileKeysByTopic {
		keys := map[string]struct{}{volatileTimestampKey: {}}
		for _, name := range names {
			keys[name] = struct{}{}
		}
		sets[topic] = keys
	}
	return sets
}

// volatileKeysFor returns the set of field names diffKey zeroes for topic.
// The returned map is shared and must not be mutated.
func volatileKeysFor(topic string) map[string]struct{} {
	if keys, ok := volatileKeySets[topic]; ok {
		return keys
	}
	return defaultVolatileKeys
}

// stripVolatileTimestamps recursively zeroes every entry of v (a
// json.Unmarshal-into-any result: nested map[string]any / []any / scalars)
// whose key is in keys, in place.
func stripVolatileTimestamps(v any, keys map[string]struct{}) {
	switch val := v.(type) {
	case map[string]any:
		for k, sub := range val {
			if _, ok := keys[k]; ok {
				val[k] = 0
				continue
			}
			stripVolatileTimestamps(sub, keys)
		}
	case []any:
		for _, sub := range val {
			stripVolatileTimestamps(sub, keys)
		}
	}
}

func (h *Hub) recordFetchError(t *topicState, err error) {
	slog.Warn("hub: poll failed", "topic", t.name, "err", err)

	h.mu.Lock()
	defer h.mu.Unlock()
	t.lastObservedAt = time.Time{}
	t.fullFresh = false
	if t.name == "users" {
		t.usersGaugesOK = false
	}
	ev := Event{Seq: h.nextSeqLocked(), Topic: t.name, Err: sourceErrorCode, TS: time.Now().Unix()}
	h.appendRingLocked(ev)
	h.broadcastLocked(ev)
	// The last good snapshot (t.lastData) is left untouched: a stale value
	// beats resetting subscribers' cache to nothing.
}

func (h *Hub) nextSeqLocked() uint64 {
	h.seq++
	return h.seq
}

func (h *Hub) appendRingLocked(ev Event) {
	h.ring = append(h.ring, ev)
	h.ringBytes += len(ev.Data)
	for len(h.ring) > h.cfg.ReplayRingSize || h.ringBytes > h.cfg.ReplayMaxBytes {
		h.ringBytes -= len(h.ring[0].Data)
		// A reslice alone would leave the discarded RawMessage reachable
		// through the backing array.
		h.ring[0] = Event{}
		h.ring = h.ring[1:]
	}
}

// broadcastLocked fans ev out to every subscriber interested in its topic.
// A subscriber whose buffer is full is a slow client: broadcastLocked
// closes it rather than blocking, so one stuck client never stalls the
// poller or other subscribers (spec 02-hub-sse.md).
func (h *Hub) broadcastLocked(ev Event) {
	for id, sub := range h.subscribers {
		if _, want := sub.topics[ev.Topic]; !want {
			continue
		}
		select {
		case sub.ch <- ev:
		default:
			h.closeSubscriberLocked(id, sub)
		}
	}
}

// ReplaySince returns the retained events for topics with Seq > since, in
// order, plus true. It returns nil, false when since predates the ring's
// continuous retained suffix, including when byte eviction left the ring
// empty; the caller must then fall back to full snapshots.
func (h *Hub) ReplaySince(since uint64, topics []string) ([]Event, bool) {
	want := make(map[string]struct{}, len(topics))
	for _, t := range topics {
		want[t] = struct{}{}
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	if since > h.seq {
		// A Last-Event-ID beyond the hub's current sequence counter means
		// the hub restarted since the client last saw an event (seq resets
		// to 0 on restart) and the client is holding a now-stale id from a
		// previous process. Without this check, since exceeds every ring
		// event's Seq, so the loop below would return an empty (but "ok")
		// replay — the SSE handler would then skip its full-snapshot
		// fallback, leaving the client with no data until the next
		// background update.
		return nil, false
	}

	if len(h.ring) > 0 && since+1 < h.ring[0].Seq {
		return nil, false
	}
	if len(h.ring) == 0 && since < h.seq {
		return nil, false
	}
	var out []Event
	for _, ev := range h.ring {
		if ev.Seq <= since {
			continue
		}
		if _, ok := want[ev.Topic]; !ok {
			continue
		}
		out = append(out, ev)
	}
	return out, true
}

// Poke requests an immediate out-of-band poll of topic, ahead of its
// normal interval — for a caller that just mutated data the topic reports
// (a user create/patch/delete and friends; see users_handlers.go) and
// wants subscribers to see it sooner than the next scheduled tick,
// shortening the SSE-vs-GET-/api/snapshot staleness window a fixed poll
// interval otherwise leaves open. The poll still goes through the normal
// recordFetchSuccess path, so diffKey/push-on-change decides whether an
// SSE event actually goes out — Poke only asks for an earlier check, it
// never forces a broadcast.
//
//   - Unknown topic: *ErrUnknownTopic, same as Subscribe/Snapshot.
//   - Event-driven topic (currently just "update", fetch == nil): no-op.
//     There is no poller and no polled cache to refresh — PublishUpdate is
//     that topic's only data source, and it already pushes synchronously.
//   - Topic has a live poller (a subscriber is holding it, t.running):
//     wakes runPoller via t.wake, a buffered(1) non-blocking send — a
//     wake already pending absorbs this call for free (coalescing), and
//     runPoller's own floor check (Config.PokeFloor, default 500ms) caps
//     how often a wake actually triggers a fetch. Subscriber hydration
//     bypasses that floor, and every path shares the per-topic poll gate.
//   - Topic has no live poller (no subscribers, t.running false): runs a
//     one-shot synchronous full fetch through the same topic gate Snapshot
//     uses, so the cache is warmed without racing a newly started poller.
func (h *Hub) Poke(topic string) error {
	h.mu.Lock()
	t, ok := h.topics[topic]
	if !ok {
		h.mu.Unlock()
		return &ErrUnknownTopic{Topic: topic}
	}
	if t.fetch == nil {
		h.mu.Unlock()
		return nil
	}
	if !t.running {
		h.mu.Unlock()
		h.pollWithContext(h.ctx, t)
		return nil
	}
	t.pokePending = true
	h.mu.Unlock()

	select {
	case t.wake <- struct{}{}:
	default:
		// A wake is already pending — coalesced, matching this method's
		// doc comment.
	}
	return nil
}

// PokeAfter schedules a Poke(topic) call after delay via h.scheduleTimer
// (default a real time.AfterFunc; tests substitute a fake — see Hub's
// scheduleTimer field doc comment) instead of blocking the caller. For a
// mutation whose effect Telemt applies asynchronously (its config-file
// watcher, ~50ms debounce — 07-telemt-sdk.md) and whose SDK method does
// not itself wait for that to settle, an immediate Poke would likely just
// re-read the pre-mutation state; delaying by roughly that settle window
// makes the forced poll actually see the change. Fire-and-forget: the
// returned timer is never tracked or stopped (safe to fire after Close —
// Poke on a topic with a canceled Hub.ctx just fails the fetch cleanly,
// same as any other post-Close poll).
func (h *Hub) PokeAfter(topic string, delay time.Duration) {
	h.scheduleTimer(delay, func() {
		if err := h.Poke(topic); err != nil {
			slog.Warn("hub: delayed poke", "topic", topic, "err", err)
		}
	})
}

// Snapshot returns the current payload for each of topics, fetching
// synchronously (bound to ctx) for any topic that is idle (no active
// poller) or has never been polled; an active topic's cached value is
// returned as-is, without a redundant fetch. Every topic name is validated
// up front, before any fetch runs: requesting an unknown topic returns
// *ErrUnknownTopic and performs no upstream requests at all, even for the
// other, valid topics in the same call.
func (h *Hub) Snapshot(ctx context.Context, topics []string) (map[string]json.RawMessage, error) {
	h.mu.Lock()
	for _, name := range topics {
		if _, ok := h.topics[name]; !ok {
			h.mu.Unlock()
			return nil, &ErrUnknownTopic{Topic: name}
		}
	}
	h.mu.Unlock()

	out := make(map[string]json.RawMessage, len(topics))
	for _, name := range topics {
		h.mu.Lock()
		t := h.topics[name]
		// A push-only topic (nil fetch) has nothing to fetch on demand —
		// its cached value (possibly still empty) is always "fresh".
		version := t.fullVersion
		fresh := t.fetch == nil || (t.running && t.hasData && t.fullFresh && !t.fullPending)
		h.mu.Unlock()

		if !fresh {
			h.pollWithProfile(ctx, t, pollFull, recheckSnapshot, version)
		}

		h.mu.Lock()
		if t.hasData {
			out[name] = t.lastData
		} else {
			out[name] = nil
		}
		h.mu.Unlock()
	}
	return out, nil
}

// PublishUpdate pushes a new snapshot into the event-driven "update" topic
// (see New). Unlike every other topic there is no poller behind it: the
// update engine and auto-updater call this directly whenever a run's phase
// changes or an auto-check finds something to report. Subscribing works
// exactly like any other topic — a new subscriber gets the last published
// snapshot immediately (Subscribe's t.hasData check), and later pushes
// broadcast the same way a poller's fetch result would (recordFetchSuccess
// already dedupes an unchanged payload, same as a polled topic).
func (h *Hub) PublishUpdate(data json.RawMessage) {
	h.mu.Lock()
	t := h.topics["update"]
	h.mu.Unlock()
	h.recordFetchSuccess(t, data, nil)
}

// Close stops every poller and disconnects every subscriber. Safe to call
// once, typically from the HTTP server's shutdown path.
func (h *Hub) Close() {
	h.cancel()

	h.mu.Lock()
	for _, t := range h.topics {
		if t.graceTimer != nil {
			t.graceTimer.Stop()
			t.graceTimer = nil
		}
		if t.running {
			close(t.stop)
			t.running = false
		}
		t.subCount = 0
	}
	for id, sub := range h.subscribers {
		if !sub.closed {
			sub.closed = true
			close(sub.ch)
		}
		delete(h.subscribers, id)
	}
	h.mu.Unlock()

	h.wg.Wait()
	h.flushUserIPs()
}
