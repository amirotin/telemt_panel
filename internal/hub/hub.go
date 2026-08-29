// Package hub polls Telemt on behalf of every connected client and fans
// out changes over Server-Sent Events. See v2/specs/02-hub-sse.md: one
// poller per topic no matter how many subscribers, the client never picks
// the interval, and a push happens only when the normalized snapshot
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

	// History metric names (store.RecordMetric/MetricRange series keys),
	// matching api/openapi.yaml GetHistory's `metric` enum values that this
	// milestone actually records (see recordStatsHistory).
	metricConnections = "connections"
	metricActiveUsers = "active_users"
	metricTraffic     = "traffic"
	// metricRefusals is the monotonic refusals counter refusals.go builds
	// out of the summary's cumulative failure counters — a series whose
	// window delta is the number of clients turned away in that window.
	metricRefusals = "refusals"
)

// Config configures the hub's poll intervals and lifecycle timings. Zero
// fields fall back to the production defaults above.
type Config struct {
	UsersInterval     time.Duration
	StatsInterval     time.Duration
	RuntimeInterval   time.Duration
	UpstreamsInterval time.Duration
	SecurityInterval  time.Duration
	WebInterval       time.Duration
	Grace             time.Duration
	Heartbeat         time.Duration
	SubscriberBuffer  int
	ReplayRingSize    int
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
type fetchFunc func(ctx context.Context) (json.RawMessage, error)

// topicState is one topic's poller lifecycle and cache, guarded by Hub.mu.
type topicState struct {
	name     string
	interval time.Duration
	fetch    fetchFunc

	subCount   int
	running    bool
	stop       chan struct{}
	graceTimer *time.Timer

	hasData   bool
	lastData  json.RawMessage
	lastKey   json.RawMessage
	lastEvent Event

	// wake carries Poke requests to runPoller: a buffered(1), non-blocking
	// send so concurrent Poke calls coalesce into at most one pending
	// forced poll. nil for topics with no poller (fetch == nil, i.e.
	// "update").
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
	cfg Config
	st  store.Store

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	mu          sync.Mutex
	topics      map[string]*topicState
	subscribers map[uint64]*subscriber
	nextSubID   uint64
	seq         uint64
	ring        []Event

	// refusals holds the running total behind the "refusals" history
	// series across polls (refusals.go) — its own lock, since
	// recordStatsHistory runs outside h.mu.
	refusals refusalsAccumulator

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

// New creates a Hub polling tc for this package's topic registry (users,
// stats, runtime, upstreams, security, web). No poller runs until the first
// Subscribe call for its topic. st records the "stats" topic's history
// points (recordStatsHistory) into the RAM ring GET /api/history reads;
// nil is accepted (e.g. tests that don't exercise history) and simply
// skips recording.
func New(cfg Config, tc *telemt.Client, st store.Store) *Hub {
	cfg = cfg.withDefaults()
	ctx, cancel := context.WithCancel(context.Background())
	h := &Hub{
		cfg:         cfg,
		st:          st,
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
	h.topics = map[string]*topicState{
		"users": {
			name:     "users",
			wake:     make(chan struct{}, 1),
			interval: cfg.UsersInterval,
			fetch:    func(ctx context.Context) (json.RawMessage, error) { return fetchUsers(ctx, tc) },
		},
		"stats": {
			name:     "stats",
			wake:     make(chan struct{}, 1),
			interval: cfg.StatsInterval,
			fetch:    func(ctx context.Context) (json.RawMessage, error) { return fetchStats(ctx, tc, sysInfo) },
		},
		"runtime": {
			name:     "runtime",
			wake:     make(chan struct{}, 1),
			interval: cfg.RuntimeInterval,
			fetch:    func(ctx context.Context) (json.RawMessage, error) { return fetchRuntime(ctx, tc) },
		},
		"upstreams": {
			name:     "upstreams",
			wake:     make(chan struct{}, 1),
			interval: cfg.UpstreamsInterval,
			fetch:    func(ctx context.Context) (json.RawMessage, error) { return fetchUpstreams(ctx, tc) },
		},
		"security": {
			name:     "security",
			wake:     make(chan struct{}, 1),
			interval: cfg.SecurityInterval,
			fetch:    func(ctx context.Context) (json.RawMessage, error) { return fetchSecurity(ctx, tc) },
		},
		"web": {
			name:     "web",
			wake:     make(chan struct{}, 1),
			interval: cfg.WebInterval,
			fetch:    func(ctx context.Context) (json.RawMessage, error) { return fetchWeb(ctx, tc) },
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
	Users          []telemt.UserInfo            `json:"users"`
	Quota          map[string]telemt.QuotaEntry `json:"quota"`
	QuotaSupported bool                         `json:"quota_supported"`
}

func fetchUsers(ctx context.Context, tc *telemt.Client) (json.RawMessage, error) {
	users, err := tc.Users(ctx)
	if err != nil {
		return nil, err
	}
	// Both calls run under the poll's own context/timeout — a quota hiccup
	// must not cost the users topic its own budget twice.
	quota, hasQuota, err := tc.QuotaList(ctx)
	if err != nil {
		slog.Warn("hub: users topic: quota list", "err", err)
		quota, hasQuota = nil, false
	}
	return json.Marshal(usersSnapshot{Users: users, Quota: quota, QuotaSupported: hasQuota})
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

func fetchStats(ctx context.Context, tc *telemt.Client, sysInfo *statsSysInfoRefresher) (json.RawMessage, error) {
	var snap statsSnapshot
	health, healthErr := tc.Health(ctx)
	if healthErr == nil {
		snap.Health = &health
	}
	summary, summaryErr := tc.StatsSummary(ctx)
	if summaryErr == nil {
		snap.Summary = &summary
	}
	ready, readyErr := tc.Ready(ctx)
	if readyErr == nil {
		snap.Ready = &ready
	}
	// Every primary sub-call failing means Telemt itself is unreachable, so
	// this must surface as a fetch error — the source_error/backoff path —
	// not a silent all-null snapshot. Any one succeeding still publishes.
	if healthErr != nil && summaryErr != nil && readyErr != nil {
		return nil, fmt.Errorf("stats: %w", errors.Join(healthErr, summaryErr, readyErr))
	}

	if caps, err := tc.Capabilities(ctx); err == nil && caps.RuntimeEdge {
		if cs, err := tc.ConnectionsSummary(ctx); err == nil {
			snap.ConnectionsSummary = &cs
		} else {
			slog.Warn("hub: stats topic: connections summary", "err", err)
		}
	}

	if info, ok := sysInfo.get(ctx); ok {
		snap.Version = info.version
		snap.UptimeSeconds = info.uptime
		snap.ConfigReloadCount = info.configReloadCount
		snap.LastConfigReloadEpochSecs = info.lastConfigReload
	}

	return json.Marshal(snap)
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

func fetchRuntime(ctx context.Context, tc *telemt.Client) (json.RawMessage, error) {
	var snap runtimeSnapshot
	var errs []error

	if v, err := tc.Gates(ctx); err == nil {
		snap.Gates = &v
	} else {
		errs = append(errs, err)
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
		return nil, fmt.Errorf("runtime: %w", errors.Join(errs...))
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
	if v, err := tc.UpstreamQuality(ctx); err == nil {
		snap.UpstreamQuality = &v
	} else {
		slog.Warn("hub: runtime topic: upstream quality", "err", err)
	}

	if caps, err := tc.Capabilities(ctx); err == nil && caps.RuntimeEdge {
		if v, err := tc.RecentEvents(ctx, recentEventsLimit); err == nil {
			snap.RecentEvents = &v
		} else {
			slog.Warn("hub: runtime topic: recent events", "err", err)
		}
	}

	return json.Marshal(snap)
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

func fetchUpstreams(ctx context.Context, tc *telemt.Client) (json.RawMessage, error) {
	var snap upstreamsSnapshot
	var upstreamsErr, dcsErr, meWritersErr error

	if v, err := tc.Upstreams(ctx); err == nil {
		snap.Upstreams = &v
	} else {
		upstreamsErr = err
	}
	if v, err := tc.DCs(ctx); err == nil {
		snap.DCs = &v
	} else {
		dcsErr = err
	}
	if v, err := tc.MeWriters(ctx); err == nil {
		snap.MeWriters = &v
	} else {
		meWritersErr = err
	}
	if upstreamsErr != nil && dcsErr != nil && meWritersErr != nil {
		return nil, fmt.Errorf("upstreams: %w", errors.Join(upstreamsErr, dcsErr, meWritersErr))
	}
	return json.Marshal(snap)
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

func fetchSecurity(ctx context.Context, tc *telemt.Client) (json.RawMessage, error) {
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
		return nil, fmt.Errorf("security: %w", errors.Join(postureErr, whitelistErr, limitsErr))
	}

	return json.Marshal(snap)
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

func fetchWeb(ctx context.Context, tc *telemt.Client) (json.RawMessage, error) {
	status, err := tc.WebStatus(ctx)
	switch {
	case err == nil:
		gated := telemt.Gated[telemt.WebStatusData]{
			Enabled: status.Available,
			Reason:  status.Reason,
			Data:    &status,
		}
		return json.Marshal(webSnapshot{Status: &gated})
	case telemt.IsWebRouteAbsent(err):
		// Telemt < 3.5.3 does not register /v1/runtime/web/* at all. Not an
		// error: an old build is a state the panel renders, not a failure.
		return json.Marshal(webSnapshot{Status: &telemt.Gated[telemt.WebStatusData]{Reason: webGateReasonUnsupported}})
	case telemt.IsWebRuntimeUnavailable(err):
		// Defensive: the status route itself never answers 503 today, but
		// the code is the group's documented "runtime is not running"
		// signal and mapping it to a closed gate keeps the topic honest if
		// a future build starts using it here too.
		return json.Marshal(webSnapshot{Status: &telemt.Gated[telemt.WebStatusData]{Reason: telemt.CodeWebRuntimeUnavailable}})
	default:
		return nil, fmt.Errorf("web: %w", err)
	}
}

// recordStatsHistory appends one point to each history metric series
// (ruling R3: RAM ring only) this milestone tracks from a just-fetched
// "stats" topic snapshot: connections, active_users and traffic. A metric
// this tick can't derive — no runtime_edge and the "users" topic hasn't
// been polled yet — is simply skipped for this tick rather than recording
// a misleading value; GET /api/history degrades to fewer points, never an
// error. Documented choice of source field per metric:
//   - connections/active_users: the runtime-edge ConnectionsSummary's live
//     Totals when available (accurate concurrent counts); otherwise the
//     coarser StatsSummary proxies (ConnectionsTotal is a cumulative
//     counter, not concurrent; ConfiguredUsers is not "active" — both are
//     the closest fields StatsSummary actually exposes without runtime_edge).
//   - refusals: the monotonic running total refusalsAccumulator folds out
//     of StatsSummary's cumulative failure counters (refusals.go) — skipped
//     entirely when the summary sub-call failed this tick, since the
//     accumulator must not mistake a missing sample for a counter reset.
//   - traffic: StatsSummary/ConnectionsSummary expose no byte-traffic
//     aggregate at all, so this sums TotalOctets across the "users" topic's
//     latest cached snapshot (already polled independently) — skipped
//     entirely until that topic has been fetched at least once.
func (h *Hub) recordStatsHistory(data json.RawMessage) {
	if h.st == nil {
		return
	}
	var snap statsSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		slog.Warn("hub: history: decode stats snapshot", "err", err)
		return
	}
	ts := time.Now().Unix()

	switch {
	case snap.ConnectionsSummary != nil && snap.ConnectionsSummary.Enabled && snap.ConnectionsSummary.Data != nil:
		totals := snap.ConnectionsSummary.Data.Totals
		h.recordMetric(metricConnections, ts, float64(totals.CurrentConnections))
		h.recordMetric(metricActiveUsers, ts, float64(totals.ActiveUsers))
	case snap.Summary != nil:
		h.recordMetric(metricConnections, ts, float64(snap.Summary.ConnectionsTotal))
		h.recordMetric(metricActiveUsers, ts, float64(snap.Summary.ConfiguredUsers))
	}

	if snap.Summary != nil {
		total := h.refusals.observe(refusalsTotal(snap.Summary), snap.Summary.UptimeSeconds)
		h.recordMetric(metricRefusals, ts, float64(total))
	}

	if traffic, ok := h.usersTrafficTotal(); ok {
		h.recordMetric(metricTraffic, ts, traffic)
	}
}

// usersTrafficTotal sums TotalOctets across the "users" topic's latest
// cached snapshot. ok is false when that topic has never been polled yet
// (hasData false) or its cached payload fails to decode.
func (h *Hub) usersTrafficTotal() (total float64, ok bool) {
	h.mu.Lock()
	t := h.topics["users"]
	hasData, data := t.hasData, t.lastData
	h.mu.Unlock()
	if !hasData {
		return 0, false
	}
	var snap usersSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		return 0, false
	}
	var sum uint64
	for _, u := range snap.Users {
		sum += u.TotalOctets
	}
	return float64(sum), true
}

func (h *Hub) recordMetric(name string, ts int64, value float64) {
	if err := h.st.RecordMetric(name, store.MetricPoint{TS: ts, Value: value}); err != nil {
		slog.Warn("hub: record metric", "metric", name, "err", err)
	}
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
		t.subCount++
		if t.graceTimer != nil {
			t.graceTimer.Stop()
			t.graceTimer = nil
		}
		// A nil fetch marks a push-only topic (see New's "update" entry):
		// there is nothing to poll, so no poller ever starts for it — its
		// snapshot only ever changes via PublishUpdate.
		if !t.running && t.fetch != nil {
			t.running = true
			t.stop = make(chan struct{})
			h.wg.Add(1)
			go h.runPoller(t)
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
		if t.subCount == 0 && t.graceTimer == nil {
			t.graceTimer = time.AfterFunc(h.cfg.Grace, func() { h.stopIfIdle(t) })
		}
	}
}

func (h *Hub) stopIfIdle(t *topicState) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if t.subCount != 0 || !t.running {
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
// Poke-triggered wake (t.wake) is handled the same way as a normal timer
// tick, subject to the poke floor (t.lastForcedPollAt, touched only here —
// see topicState's doc comment) — this is the only place t.fetch is ever
// called for t, so two polls of the same topic can never run concurrently.
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
			if h.poll(t) {
				backoff = t.interval
			} else {
				backoff *= 2
				if backoff > maxBackoff {
					backoff = maxBackoff
				}
			}
			resetTimer(backoff)
		case <-t.wake:
			if h.now().Sub(t.lastForcedPollAt) < h.cfg.PokeFloor {
				// Another forced poll happened too recently — drop this
				// wake rather than queue it; the data is already about as
				// fresh as Poke could make it, and the normal interval
				// timer above is still running unaffected.
				continue
			}
			t.lastForcedPollAt = h.now()
			if h.poll(t) {
				backoff = t.interval
			} else {
				backoff *= 2
				if backoff > maxBackoff {
					backoff = maxBackoff
				}
			}
			resetTimer(backoff)
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
	data, err := t.fetch(ctx)
	if err != nil {
		h.recordFetchError(t, err)
		return false
	}
	// recordStatsHistory reads the "users" topic's cache under h.mu itself
	// (usersTrafficTotal) — it must run before recordFetchSuccess takes
	// that same lock below, not while holding it (sync.Mutex isn't
	// reentrant).
	if t.name == "stats" {
		h.recordStatsHistory(data)
		if h.historyRecordedHook != nil {
			h.historyRecordedHook()
		}
	}
	h.recordFetchSuccess(t, data)
	return true
}

func (h *Hub) recordFetchSuccess(t *topicState, data json.RawMessage) {
	h.mu.Lock()
	defer h.mu.Unlock()
	key := diffKey(t.name, data)
	if t.hasData && bytes.Equal(t.lastKey, key) {
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
// snapshot: a copy with every "generated_at_epoch_secs" field zeroed,
// wherever it appears in the (possibly nested) JSON object. The payload
// actually cached/broadcast to subscribers (t.lastData/ev.Data above) keeps
// the real timestamps — only this comparison key strips them.
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
// Implemented as a single generic JSON walk (decode, zero any key literally
// named "generated_at_epoch_secs" at any depth, re-encode) rather than
// per-fetcher special-casing, since the field appears in several different
// shapes across the four affected topics: nested inside Gated[T]'s
// generated_at_epoch_secs, and as a top-level field on the flat
// DcStatusData/MeWritersData/UpstreamsData/SecurityWhitelistData structs.
// This also means any *future* endpoint added to a topic with the same
// field name is covered automatically, with no separate opt-in.
//
// One topic needs more than that one key, which is why the topic name is a
// parameter: see volatileKeysByTopic.
func diffKey(topic string, data json.RawMessage) json.RawMessage {
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

// volatileTimestampKey is the JSON field name diffKey strips on EVERY topic
// — see its doc comment. A single named constant so every occurrence
// (Gated[T], the flat stats-group structs) is covered by construction
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
// because diffKey runs on EVERY successful poll of EVERY topic, and the
// poll loop does not allocate (Global Constraints).
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
	if len(h.ring) > h.cfg.ReplayRingSize {
		h.ring = h.ring[len(h.ring)-h.cfg.ReplayRingSize:]
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

// ReplaySince returns the events for topics with Seq > since, in order,
// plus true — or nil, false if since predates the ring's oldest retained
// event (some events were lost; the caller must fall back to full
// snapshots).
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
//     how often a wake actually triggers a fetch. Since t.fetch is only
//     ever called from runPoller's single goroutine, this can never race
//     with — or run concurrently alongside — that topic's normal polling.
//   - Topic has no live poller (no subscribers, t.running false): runs a
//     one-shot synchronous fetch (the same on-demand path Snapshot uses
//     for an idle topic) so the cached snapshot is warm. Note that
//     Snapshot re-fetches an idle topic on every call anyway, so this
//     branch mainly keeps the cache and the source_error/backoff state
//     current; it is cheap and harmless. Narrow, accepted race: if a new subscriber
//     starts this topic's poller in the brief window between this check
//     and the fetch actually running, both fetches proceed independently
//     — recordFetchSuccess is safe under concurrent callers (Hub.mu), so
//     the only cost is one harmless duplicate Telemt round trip, not a
//     correctness issue.
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
		fresh := t.fetch == nil || (t.running && t.hasData)
		h.mu.Unlock()

		if !fresh {
			h.pollWithContext(ctx, t)
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
	h.recordFetchSuccess(t, data)
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
}
