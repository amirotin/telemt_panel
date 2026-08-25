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
	defaultGrace             = 30 * time.Second
	defaultHeartbeat         = 25 * time.Second
	defaultSubscriberBuffer  = 64
	defaultReplayRingSize    = 256

	// defaultStatsSysInfoRefresh bounds how often the "stats" topic's poll
	// re-fetches GET /v1/system/info for its version/uptime fields — every
	// 5s stats poll would be wasteful for values that rarely change (spec
	// task brief: "every 12th poll or 60s"). 60s at the default 5s stats
	// interval is exactly the 12th-poll cadence the brief suggests.
	defaultStatsSysInfoRefresh = 60 * time.Second

	// maxBackoff caps the exponential backoff applied to a topic's poll
	// interval while its upstream fetch keeps failing.
	maxBackoff = 60 * time.Second

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
)

// Config configures the hub's poll intervals and lifecycle timings. Zero
// fields fall back to the production defaults above.
type Config struct {
	UsersInterval     time.Duration
	StatsInterval     time.Duration
	RuntimeInterval   time.Duration
	UpstreamsInterval time.Duration
	SecurityInterval  time.Duration
	Grace             time.Duration
	Heartbeat         time.Duration
	SubscriberBuffer  int
	ReplayRingSize    int
	// StatsSysInfoRefresh overrides defaultStatsSysInfoRefresh; tests set
	// this small to observe the refresh without a real 60s wait.
	StatsSysInfoRefresh time.Duration
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
	lastEvent Event
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
}

// New creates a Hub polling tc for this package's topic registry (users,
// stats, runtime, upstreams, security). No poller runs until the first
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
	}
	sysInfo := &statsSysInfoRefresher{tc: tc, interval: cfg.StatsSysInfoRefresh, now: time.Now}
	h.topics = map[string]*topicState{
		"users": {
			name:     "users",
			interval: cfg.UsersInterval,
			fetch:    func(ctx context.Context) (json.RawMessage, error) { return fetchUsers(ctx, tc) },
		},
		"stats": {
			name:     "stats",
			interval: cfg.StatsInterval,
			fetch:    func(ctx context.Context) (json.RawMessage, error) { return fetchStats(ctx, tc, sysInfo) },
		},
		"runtime": {
			name:     "runtime",
			interval: cfg.RuntimeInterval,
			fetch:    func(ctx context.Context) (json.RawMessage, error) { return fetchRuntime(ctx, tc) },
		},
		"upstreams": {
			name:     "upstreams",
			interval: cfg.UpstreamsInterval,
			fetch:    func(ctx context.Context) (json.RawMessage, error) { return fetchUpstreams(ctx, tc) },
		},
		"security": {
			name:     "security",
			interval: cfg.SecurityInterval,
			fetch:    func(ctx context.Context) (json.RawMessage, error) { return fetchSecurity(ctx, tc) },
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

	if version, uptime, ok := sysInfo.get(ctx); ok {
		snap.Version = version
		snap.UptimeSeconds = uptime
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
	version string
	uptime  float64
	hasData bool
}

// get returns the cached version/uptime if still fresh, otherwise re-fetches
// GET /v1/system/info. ok is false only when there is neither a fresh nor a
// stale cached value AND the fetch itself failed — the stats topic then
// simply omits Version/UptimeSeconds for this tick rather than blocking on
// it or failing the whole poll.
func (r *statsSysInfoRefresher) get(ctx context.Context) (version string, uptime float64, ok bool) {
	r.mu.Lock()
	if r.hasData && r.now().Sub(r.lastAt) < r.interval {
		version, uptime = r.version, r.uptime
		r.mu.Unlock()
		return version, uptime, true
	}
	r.mu.Unlock()

	info, err := r.tc.SystemInfo(ctx)
	if err != nil {
		r.mu.Lock()
		version, uptime, ok = r.version, r.uptime, r.hasData
		r.mu.Unlock()
		return version, uptime, ok
	}

	r.mu.Lock()
	r.version, r.uptime, r.hasData, r.lastAt = info.Version, info.UptimeSeconds, true, r.now()
	version, uptime = r.version, r.uptime
	r.mu.Unlock()
	return version, uptime, true
}

// runtimeSnapshot is the "runtime" topic's composite payload (spec
// 02-hub-sse.md / M3 task-2 brief): the always-on Gates/Initialization
// group plus the ME-pool/quality/NAT-STUN/self-test Gated[T] group. Any
// sub-call failing leaves its field null and the topic still publishes;
// every one of the six failing is treated as Telemt being unreachable.
// RecentEvents is included only when the runtime_edge capability is on.
type runtimeSnapshot struct {
	Gates          *telemt.RuntimeGatesData                        `json:"gates"`
	Initialization *telemt.RuntimeInitializationData               `json:"initialization"`
	MePoolState    *telemt.Gated[telemt.RuntimeMePoolStatePayload] `json:"me_pool_state"`
	MeQuality      *telemt.Gated[telemt.RuntimeMeQualityPayload]   `json:"me_quality"`
	NatStun        *telemt.Gated[telemt.RuntimeNatStunPayload]     `json:"nat_stun"`
	MeSelfTest     *telemt.Gated[telemt.RuntimeMeSelftestPayload]  `json:"me_selftest"`
	RecentEvents   *telemt.Gated[telemt.RuntimeEdgeEventsPayload]  `json:"recent_events,omitempty"`
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

	if caps, err := tc.Capabilities(ctx); err == nil && caps.RuntimeEdge {
		if v, err := tc.RecentEvents(ctx, 0); err == nil {
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
// Whitelist + EffectiveLimits (spec 02-hub-sse.md / M3 task-2 brief), plus
// TLSFingerprints when the runtime_edge capability is on. Any one of the
// first three failing leaves its field null and the topic still publishes;
// all three failing is treated as Telemt being unreachable.
type securitySnapshot struct {
	Posture         *telemt.SecurityPostureData                             `json:"posture"`
	Whitelist       *telemt.SecurityWhitelistData                           `json:"whitelist"`
	EffectiveLimits *telemt.EffectiveLimitsData                             `json:"effective_limits"`
	TLSFingerprints *telemt.Gated[telemt.RuntimeEdgeTLSFingerprintsPayload] `json:"tls_fingerprints,omitempty"`
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

	if caps, err := tc.Capabilities(ctx); err == nil && caps.RuntimeEdge {
		if v, err := tc.TLSFingerprints(ctx, 0); err == nil {
			snap.TLSFingerprints = &v
		} else {
			slog.Warn("hub: security topic: tls fingerprints", "err", err)
		}
	}

	return json.Marshal(snap)
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
// fetch errors up to maxBackoff and resetting it on the next success.
func (h *Hub) runPoller(t *topicState) {
	defer h.wg.Done()

	stop := t.stop
	backoff := t.interval
	timer := time.NewTimer(0)
	defer timer.Stop()

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
			timer.Reset(backoff)
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
	}
	h.recordFetchSuccess(t, data)
	return true
}

func (h *Hub) recordFetchSuccess(t *topicState, data json.RawMessage) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if t.hasData && bytes.Equal(t.lastData, data) {
		return
	}
	t.hasData = true
	t.lastData = data
	ev := Event{Seq: h.nextSeqLocked(), Topic: t.name, Data: data, TS: time.Now().Unix()}
	t.lastEvent = ev
	h.appendRingLocked(ev)
	h.broadcastLocked(ev)
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
