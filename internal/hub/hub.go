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

	"github.com/amirotin/telemt_panel/internal/telemt"
)

// Default poll intervals and lifecycle timings (spec 02-hub-sse.md). Tests
// override these via Config with millisecond-scale values.
const (
	defaultUsersInterval    = 10 * time.Second
	defaultStatsInterval    = 5 * time.Second
	defaultGrace            = 30 * time.Second
	defaultHeartbeat        = 25 * time.Second
	defaultSubscriberBuffer = 64
	defaultReplayRingSize   = 256

	// maxBackoff caps the exponential backoff applied to a topic's poll
	// interval while its upstream fetch keeps failing.
	maxBackoff = 60 * time.Second

	// sourceErrorCode is the SSE source_error event's code for any fetch
	// failure; the panel does not currently need finer-grained
	// classification of the underlying Telemt error.
	sourceErrorCode = "telemt_unreachable"
)

// Config configures the hub's poll intervals and lifecycle timings. Zero
// fields fall back to the production defaults above.
type Config struct {
	UsersInterval    time.Duration
	StatsInterval    time.Duration
	Grace            time.Duration
	Heartbeat        time.Duration
	SubscriberBuffer int
	ReplayRingSize   int
}

func (c Config) withDefaults() Config {
	if c.UsersInterval <= 0 {
		c.UsersInterval = defaultUsersInterval
	}
	if c.StatsInterval <= 0 {
		c.StatsInterval = defaultStatsInterval
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
// stats). No poller runs until the first Subscribe call for its topic.
func New(cfg Config, tc *telemt.Client) *Hub {
	cfg = cfg.withDefaults()
	ctx, cancel := context.WithCancel(context.Background())
	h := &Hub{
		cfg:         cfg,
		ctx:         ctx,
		cancel:      cancel,
		subscribers: make(map[uint64]*subscriber),
	}
	h.topics = map[string]*topicState{
		"users": {
			name:     "users",
			interval: cfg.UsersInterval,
			fetch:    func(ctx context.Context) (json.RawMessage, error) { return fetchUsers(ctx, tc) },
		},
		"stats": {
			name:     "stats",
			interval: cfg.StatsInterval,
			fetch:    func(ctx context.Context) (json.RawMessage, error) { return fetchStats(ctx, tc) },
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

// statsSnapshot is the "stats" topic's composite payload. Health and
// StatsSummary are fetched independently; either may be null if its
// sub-call failed — the topic still publishes rather than source_error-ing.
type statsSnapshot struct {
	Health  *telemt.HealthData  `json:"health"`
	Summary *telemt.SummaryData `json:"summary"`
}

func fetchStats(ctx context.Context, tc *telemt.Client) (json.RawMessage, error) {
	var snap statsSnapshot
	health, healthErr := tc.Health(ctx)
	if healthErr == nil {
		snap.Health = &health
	}
	summary, summaryErr := tc.StatsSummary(ctx)
	if summaryErr == nil {
		snap.Summary = &summary
	}
	// A single sub-call failing still publishes (the other field carries
	// real data); both failing means Telemt itself is unreachable, so this
	// must surface as a fetch error — the source_error/backoff path — not
	// a silent {"health":null,"summary":null} snapshot.
	if healthErr != nil && summaryErr != nil {
		return nil, fmt.Errorf("stats: %w", errors.Join(healthErr, summaryErr))
	}
	return json.Marshal(snap)
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
