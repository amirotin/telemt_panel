package store

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

// Ring caps for the in-memory bounded collections.
const (
	auditCap   = 500
	journalCap = 100
	eventCap   = 1000
)

// MetricCap bounds each named metric series (RecordMetric/MetricRange).
//
// At the hub's default 5s "stats" poll interval (internal/hub,
// recordStatsHistory) 360 points are 30 minutes of raw history. Thirty, not
// the original fifteen of ruling R3 (v2/specs/02-hub-sse.md, M3 task-2),
// because Сводка's KPI captions compare the last 15 minutes against the 15
// before them ("−0,3 % за 15 мин") — with a 15-minute ring there is no
// previous window to compare against, only two halves of the current one.
//
// The cost stays small and, more importantly, stays BOUNDED. The hub records
// six global series today; aggregate-only fields remain zero in memory and the
// ring size stays fixed regardless of uptime.
const MetricCap = 360

// touchMirrorDebounce caps how often a TouchSession-triggered mirror write
// happens: at most once per this interval, however many touches land in
// between.
const touchMirrorDebounce = 30 * time.Second

// Memory is an in-memory Store for the router profile: no flash writes,
// bounded by ring buffers. Sessions, subpage nonces, settings and the
// update journal can optionally be mirrored to a JSON file so they survive
// a process restart. TOTP state and recovery hashes are part of that mandatory
// mirrored subset; audit and metric history remain process-lifetime only.
type Memory struct {
	mu sync.Mutex

	sessions            map[string]Session
	audit               []AuditEntry
	events              []HistoryEvent
	journal             map[string][]UpdateJournalEntry
	metrics             map[string][]MetricPoint
	subpageNonces       map[string]string
	settings            map[string]string
	policies            map[StorageCategory]StoragePolicy
	totp                TOTPState
	recoveryCodes       map[string]struct{}
	webauthnUserHandle  []byte
	webauthnCredentials map[string]WebAuthnCredential
	webauthnChallenges  map[string]WebAuthnChallenge
	nextEventID         int64

	mirrorPath string

	// Touch debounce: TouchSession marks the mirror dirty and defers the
	// write to a timer that fires at most once per mirrorDebounce, instead
	// of writing on every touch. All other mutations still write through
	// saveMirrorLocked immediately. scheduleTimer is the injection point
	// tests use to control the timer deterministically, without real
	// waits; it returns a stop func, mirroring time.Timer.Stop.
	mirrorDebounce time.Duration
	touchDirty     bool
	stopTouchTimer func()
	scheduleTimer  func(d time.Duration, f func()) (stop func())
}

// Driver returns the backend name.
func (m *Memory) Driver() string { return "memory" }

// Info reports the volatile memory backend capabilities.
func (m *Memory) Info() Info {
	return Info{Driver: "memory", Durable: false, Remote: false, Schema: 0, SizeHint: 0}
}

// mirrorFile is the on-disk shape of the mirrored subset of state
// (sessions, auth state, subpage nonces, settings and the update journal).
type mirrorFile struct {
	Sessions            map[string]Session              `json:"sessions"`
	SubpageNonces       map[string]string               `json:"subpage_nonces"`
	Settings            map[string]string               `json:"settings"`
	Journal             map[string][]UpdateJournalEntry `json:"journal"`
	Policies            []StoragePolicy                 `json:"storage_policies,omitempty"`
	TOTP                TOTPState                       `json:"totp,omitempty"`
	RecoveryCodes       []string                        `json:"totp_recovery_codes,omitempty"`
	WebAuthnUserHandle  []byte                          `json:"webauthn_user_handle,omitempty"`
	WebAuthnCredentials map[string]WebAuthnCredential   `json:"webauthn_credentials,omitempty"`
	WebAuthnChallenges  map[string]WebAuthnChallenge    `json:"webauthn_challenges,omitempty"`
}

// NewMemory creates an in-memory Store. If mirrorPath is non-empty,
// sessions, subpage nonces, settings and the update journal are loaded
// from it now and persisted back to it on every subsequent mutation of
// those families (touches are debounced, see touchMirrorDebounce). A
// missing mirror starts empty. An existing unreadable or corrupt mirror fails
// startup: otherwise damaged persisted TOTP state could silently disappear and
// weaken authentication.
func NewMemory(mirrorPath string) (*Memory, error) {
	m := &Memory{
		sessions:            make(map[string]Session),
		journal:             make(map[string][]UpdateJournalEntry),
		metrics:             make(map[string][]MetricPoint),
		subpageNonces:       make(map[string]string),
		settings:            make(map[string]string),
		policies:            defaultPolicyMap(),
		totp:                TOTPState{LastTimestep: -1},
		recoveryCodes:       make(map[string]struct{}),
		webauthnCredentials: make(map[string]WebAuthnCredential),
		webauthnChallenges:  make(map[string]WebAuthnChallenge),
		mirrorPath:          mirrorPath,
		mirrorDebounce:      touchMirrorDebounce,
		scheduleTimer: func(d time.Duration, f func()) func() {
			t := time.AfterFunc(d, f)
			return func() { t.Stop() }
		},
	}

	if mirrorPath == "" {
		return m, nil
	}

	data, err := os.ReadFile(mirrorPath)
	if err != nil {
		if os.IsNotExist(err) {
			return m, nil
		}
		return nil, fmt.Errorf("store: mirror file is unreadable: %w", err)
	}

	var mf mirrorFile
	if err := json.Unmarshal(data, &mf); err != nil {
		return nil, fmt.Errorf("store: mirror file is corrupt: %w", err)
	}
	if mf.Sessions != nil {
		m.sessions = mf.Sessions
	}
	if mf.SubpageNonces != nil {
		m.subpageNonces = mf.SubpageNonces
	}
	if mf.Settings != nil {
		m.settings = mf.Settings
	}
	if len(mf.Policies) > 0 {
		if err := ValidateStoragePolicies(mf.Policies); err != nil {
			slog.Warn("store: mirror storage policies invalid, using defaults", "path", mirrorPath, "error", err)
		} else {
			m.policies = policyMap(mf.Policies)
		}
	}
	if mf.Journal != nil {
		// Defensive ring-cap truncation: the mirrored file is trusted
		// less than an append made through this process, so a
		// hand-edited or foreign-written file holding more than
		// journalCap entries for a target must not defeat the ring
		// bound going forward.
		for target, entries := range mf.Journal {
			if len(entries) > journalCap {
				mf.Journal[target] = entries[len(entries)-journalCap:]
			}
		}
		m.journal = mf.Journal
	}
	m.totp = mf.TOTP
	for _, hash := range mf.RecoveryCodes {
		if !validRecoveryCodeKey(hash) {
			return nil, fmt.Errorf("store: mirror contains an invalid TOTP recovery hash")
		}
		if _, duplicate := m.recoveryCodes[hash]; duplicate {
			return nil, fmt.Errorf("store: mirror contains a duplicate TOTP recovery hash")
		}
		m.recoveryCodes[hash] = struct{}{}
	}
	if err := validatePortableTOTP(m.totp, recoveryCodeHashes(m.recoveryCodes)); err != nil {
		return nil, fmt.Errorf("store: mirror contains invalid TOTP state: %w", err)
	}
	m.totp.RecoveryCodes = len(m.recoveryCodes)
	m.webauthnUserHandle = append([]byte(nil), mf.WebAuthnUserHandle...)
	if mf.WebAuthnCredentials != nil {
		m.webauthnCredentials = cloneWebAuthnCredentials(mf.WebAuthnCredentials)
	}
	if mf.WebAuthnChallenges != nil {
		m.webauthnChallenges = cloneWebAuthnChallenges(mf.WebAuthnChallenges)
	}
	if err := validatePortableWebAuthn(m.webauthnUserHandle, m.webauthnCredentials, m.webauthnChallenges); err != nil {
		return nil, fmt.Errorf("store: mirror contains invalid WebAuthn state: %w", err)
	}
	return m, nil
}

// saveMirrorLocked writes the mirrored subset of state to mirrorPath. Runtime
// mutations remain best effort; operator import uses writeMirrorLocked
// directly so it can report a persistence failure instead of losing data when
// the short-lived CLI process exits.
func (m *Memory) saveMirrorLocked() {
	if err := m.writeMirrorLocked(); err != nil {
		slog.Warn("store: mirror write failed", "path", m.mirrorPath, "error", err)
	}
}

// writeMirrorLocked persists the mirrored subset as temp + fsync + rename,
// mode 0600. Callers must hold mu.
func (m *Memory) writeMirrorLocked() error {
	if m.mirrorPath == "" {
		return nil
	}

	mf := mirrorFile{
		Sessions:            m.sessions,
		SubpageNonces:       m.subpageNonces,
		Settings:            m.settings,
		Journal:             m.journal,
		Policies:            policiesFromMap(m.policies),
		TOTP:                m.totp,
		RecoveryCodes:       recoveryCodeKeys(m.recoveryCodes),
		WebAuthnUserHandle:  append([]byte(nil), m.webauthnUserHandle...),
		WebAuthnCredentials: m.webauthnCredentials,
		WebAuthnChallenges:  m.webauthnChallenges,
	}
	data, err := json.Marshal(mf)
	if err != nil {
		return fmt.Errorf("encode mirror: %w", err)
	}

	dir := filepath.Dir(m.mirrorPath)
	tmp, err := os.CreateTemp(dir, ".store-mirror-*.tmp")
	if err != nil {
		return fmt.Errorf("create mirror temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once renamed

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write mirror: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("sync mirror: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close mirror: %w", err)
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		return fmt.Errorf("secure mirror: %w", err)
	}
	if err := os.Rename(tmpName, m.mirrorPath); err != nil {
		return fmt.Errorf("replace mirror: %w", err)
	}
	return nil
}

// PutSession creates or replaces the session keyed by s.IDHash.
func (m *Memory) PutSession(s Session) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sessions[s.IDHash] = s
	m.saveMirrorLocked()
	return nil
}

// GetSession looks up a session by its IDHash.
func (m *Memory) GetSession(idHash string) (Session, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[idHash]
	return s, ok, nil
}

// TouchSession updates LastSeen for the given session. Touching a session
// that does not exist is not an error. The mirror write is debounced (see
// mirrorDebounce) rather than immediate, since touches happen far more
// often than the other mutation families.
func (m *Memory) TouchSession(idHash string, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[idHash]
	if !ok {
		return nil
	}
	s.LastSeen = at
	m.sessions[idHash] = s
	m.scheduleMirrorLocked()
	return nil
}

// scheduleMirrorLocked marks the mirror dirty and, if no flush is already
// scheduled, arms a timer to flush it after mirrorDebounce. Callers must
// hold mu.
func (m *Memory) scheduleMirrorLocked() {
	if m.mirrorPath == "" {
		return
	}
	m.touchDirty = true
	if m.stopTouchTimer != nil {
		return // a flush is already scheduled for this window
	}
	m.stopTouchTimer = m.scheduleTimer(m.mirrorDebounce, m.flushTouch)
}

// flushTouch is the debounce timer callback: it writes the mirror if state
// is still dirty and clears the schedule so a later touch can arm a new
// window. Runs on the timer's own goroutine in production.
func (m *Memory) flushTouch() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopTouchTimer = nil
	if !m.touchDirty {
		return
	}
	m.touchDirty = false
	m.saveMirrorLocked()
}

// DeleteSession removes one session.
func (m *Memory) DeleteSession(idHash string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.sessions, idHash)
	m.saveMirrorLocked()
	return nil
}

// DeleteOtherSessions removes every session except keepIDHash.
func (m *Memory) DeleteOtherSessions(keepIDHash string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for hash := range m.sessions {
		if hash != keepIDHash {
			delete(m.sessions, hash)
		}
	}
	m.saveMirrorLocked()
	return nil
}

// ListSessions returns all sessions ordered by Created, newest first.
func (m *Memory) ListSessions() ([]Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		out = append(out, s)
	}
	slices.SortFunc(out, func(a, b Session) int { return b.Created.Compare(a.Created) })
	return out, nil
}

// AppendAudit records one audit entry, evicting the oldest if the ring is
// full.
func (m *Memory) AppendAudit(e AuditEntry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.policies[StorageAudit].Enabled {
		return nil
	}
	m.audit = append(m.audit, e)
	if len(m.audit) > auditCap {
		m.audit = m.audit[len(m.audit)-auditCap:]
	}
	return nil
}

// ListAudit returns up to limit audit entries, newest first.
func (m *Memory) ListAudit(limit int) ([]AuditEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return newestFirst(m.audit, limit), nil
}

// AppendHistoryEvent records one bounded, structured transition.
func (m *Memory) AppendHistoryEvent(event HistoryEvent) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if event.Category == "" {
		event.Category = StorageEvents
	}
	policy, ok := m.policies[event.Category]
	if !ok {
		return fmt.Errorf("unknown history event category %q", event.Category)
	}
	if !policy.Enabled {
		return nil
	}
	if event.TS.IsZero() {
		event.TS = time.Now().UTC()
	}
	m.nextEventID++
	event.ID = m.nextEventID
	event.Attributes = cloneStringMap(event.Attributes)
	m.events = append(m.events, event)
	if len(m.events) > eventCap {
		m.events = m.events[len(m.events)-eventCap:]
	}
	return nil
}

// ListHistoryEvents returns matching events newest first.
func (m *Memory) ListHistoryEvents(filter HistoryEventFilter) ([]HistoryEvent, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]HistoryEvent, 0)
	for i := len(m.events) - 1; i >= 0; i-- {
		event := m.events[i]
		if !filter.From.IsZero() && event.TS.Before(filter.From) {
			continue
		}
		if filter.Category != "" && event.Category != filter.Category {
			continue
		}
		if filter.Kind != "" && event.Kind != filter.Kind {
			continue
		}
		if filter.Entity != "" && event.Entity != filter.Entity {
			continue
		}
		event.Attributes = cloneStringMap(event.Attributes)
		out = append(out, event)
		if filter.Limit > 0 && len(out) >= filter.Limit {
			break
		}
	}
	return out, nil
}

func cloneStringMap(src map[string]string) map[string]string {
	if len(src) == 0 {
		return nil
	}
	out := make(map[string]string, len(src))
	for key, value := range src {
		out[key] = value
	}
	return out
}

// AppendUpdateJournal records one update-journal entry for e.Target,
// evicting the oldest for that target if its ring is full. Unlike
// TouchSession, this writes through to the mirror immediately rather than
// via the debounce timer: update runs are rare events (not a hot path like
// session touches), so there is no flash-wear concern, and durability
// matters more here — this is the exact state ReconcileStartup depends on
// after a restart.
func (m *Memory) AppendUpdateJournal(e UpdateJournalEntry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	entries := append(m.journal[e.Target], e)
	if len(entries) > journalCap {
		entries = entries[len(entries)-journalCap:]
	}
	m.journal[e.Target] = entries
	m.saveMirrorLocked()
	return nil
}

// ListUpdateJournal returns up to limit entries for target, newest first.
func (m *Memory) ListUpdateJournal(target string, limit int) ([]UpdateJournalEntry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return newestFirst(m.journal[target], limit), nil
}

// RecordMetric appends p to the named metric series, evicting the oldest
// point if the series ring is full.
func (m *Memory) RecordMetric(name string, p MetricPoint) error {
	return m.RecordMetrics([]NamedMetricPoint{{Name: name, Point: p}})
}

// RecordMetrics appends a poll's samples under one lock.
func (m *Memory) RecordMetrics(batch []NamedMetricPoint) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, named := range batch {
		if !m.policies[metricCategory(named.Name)].Enabled {
			continue
		}
		p := named.Point
		p.Tier = MetricTierRaw
		p.Max = 0
		p.Samples = 0
		points := append(m.metrics[named.Name], p)
		if len(points) > MetricCap {
			points = points[len(points)-MetricCap:]
		}
		m.metrics[named.Name] = points
	}
	return nil
}

// MetricRange returns the points of the named series with TS >= fromTS,
// oldest first.
func (m *Memory) MetricRange(name string, fromTS int64) ([]MetricPoint, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	all := m.metrics[name]
	out := make([]MetricPoint, 0, len(all))
	for _, p := range all {
		if p.TS >= fromTS {
			out = append(out, p)
		}
	}
	return selectMetricPoints(out, fromTS, time.Now().Unix()), nil
}

// MetricRetention reports the RAM ring's maximum history window when the
// metric category is enabled.
func (m *Memory) MetricRetention(name string) time.Duration {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.policies[metricCategory(name)].Enabled {
		return 0
	}
	return 30 * time.Minute
}

// RecordUserTraffic aggregates sparse per-user deltas without writing them to
// the optional mirror. The memory profile keeps at most one day of 15-minute
// buckets and thirty days of hourly buckets, regardless of configured policy.
func (m *Memory) RecordUserTraffic(deltas []UserTrafficDelta) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.policies[StorageUserTraffic].Enabled {
		return nil
	}
	for _, delta := range deltas {
		if delta.Username == "" || delta.TS <= 0 || delta.Bytes == 0 {
			continue
		}
		name := userTrafficMetricName(delta.Username)
		points := m.metrics[name]
		for _, tier := range []struct {
			name  MetricTier
			width time.Duration
		}{
			{name: MetricTierQuarter, width: 15 * time.Minute},
			{name: MetricTierHour, width: time.Hour},
		} {
			bucket := metricBucket(delta.TS, tier.width)
			updated := false
			for i := len(points) - 1; i >= 0; i-- {
				if points[i].Tier == tier.name && points[i].TS == bucket {
					value := float64(delta.Bytes)
					points[i].Value += value
					if value > points[i].Max {
						points[i].Max = value
					}
					points[i].Samples++
					updated = true
					break
				}
			}
			if !updated {
				value := float64(delta.Bytes)
				points = append(points, MetricPoint{TS: bucket, Value: value, Max: value, Samples: 1, Tier: tier.name})
			}
		}
		quarterCutoff := delta.TS - int64(userTrafficFineRetention/time.Second)
		hourCutoff := delta.TS - int64(userTrafficMemoryRetention/time.Second)
		kept := points[:0]
		for _, point := range points {
			if (point.Tier == MetricTierQuarter && point.TS >= quarterCutoff) ||
				(point.Tier == MetricTierHour && point.TS >= hourCutoff) {
				kept = append(kept, point)
			}
		}
		m.metrics[name] = kept
	}
	return nil
}

// UserTrafficRange returns a user's sparse traffic history.
func (m *Memory) UserTrafficRange(username string, fromTS int64) ([]MetricPoint, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.policies[StorageUserTraffic].Enabled {
		return []MetricPoint{}, nil
	}
	points := append([]MetricPoint(nil), m.metrics[userTrafficMetricName(username)]...)
	return selectUserTrafficPoints(points, fromTS, time.Now().Unix()), nil
}

// UserTrafficRetention reports the bounded RAM reach when enabled.
func (m *Memory) UserTrafficRetention() time.Duration {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.policies[StorageUserTraffic].Enabled {
		return 0
	}
	return userTrafficMemoryRetention
}

// DeleteUserHistory removes all optional history owned by username.
func (m *Memory) DeleteUserHistory(username string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.metrics, userTrafficMetricName(username))
	return nil
}

// ListStoragePolicies returns every policy in stable UI order.
func (m *Memory) ListStoragePolicies() ([]StoragePolicy, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return policiesFromMap(m.policies), nil
}

// ReplaceStoragePolicies validates and stores the complete policy set.
func (m *Memory) ReplaceStoragePolicies(policies []StoragePolicy) error {
	if err := ValidateStoragePolicies(policies); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.policies = policyMap(policies)
	m.saveMirrorLocked()
	return nil
}

// PurgeHistory removes the selected in-memory history family.
func (m *Memory) PurgeHistory(category StorageCategory) error {
	if _, ok := defaultPolicyMap()[category]; !ok {
		return fmt.Errorf("unknown storage category %q", category)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if category == StorageAudit {
		m.audit = nil
	}
	if category == StorageEvents {
		m.events = nil
	}
	for name := range m.metrics {
		if metricCategory(name) == category {
			delete(m.metrics, name)
		}
	}
	return nil
}

// StorageStats reports volatile record counts. DatabaseBytes is always zero.
func (m *Memory) StorageStats() (StorageStats, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	counts := make(map[StorageCategory]int64, len(storageCategoryOrder))
	counts[StorageAudit] = int64(len(m.audit))
	counts[StorageEvents] = int64(len(m.events))
	for name, points := range m.metrics {
		counts[metricCategory(name)] += int64(len(points))
	}
	categories := make([]StorageCategoryStats, 0, len(storageCategoryOrder))
	for _, category := range storageCategoryOrder {
		categories = append(categories, StorageCategoryStats{Category: category, Records: counts[category]})
	}
	return StorageStats{Driver: "memory", Durable: false, Categories: categories}, nil
}

// GetSubpageNonce returns the current subpage nonce for username, or "" if
// none has been set.
func (m *Memory) GetSubpageNonce(username string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.subpageNonces[username], nil
}

// SetSubpageNonce sets the subpage nonce for username.
func (m *Memory) SetSubpageNonce(username, nonce string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.subpageNonces[username] = nonce
	m.saveMirrorLocked()
	return nil
}

// GetSetting returns the value stored under key.
func (m *Memory) GetSetting(key string) (string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, ok := m.settings[key]
	return v, ok, nil
}

// SetSetting sets the value stored under key, creating or overwriting it.
func (m *Memory) SetSetting(key, value string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.settings[key] = value
	m.saveMirrorLocked()
	return nil
}

// Close stops any pending touch-debounce timer and, if a touch flush was
// still owed, flushes it synchronously before returning. Beyond the
// mirror, state is process-lifetime only.
func (m *Memory) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.stopTouchTimer != nil {
		m.stopTouchTimer()
		m.stopTouchTimer = nil
	}
	if m.touchDirty {
		m.touchDirty = false
		m.saveMirrorLocked()
	}
	return nil
}

// newestFirst returns up to limit elements of src in reverse order
// (newest-appended first). limit <= 0 means no cap.
func newestFirst[T any](src []T, limit int) []T {
	n := len(src)
	if limit > 0 && limit < n {
		n = limit
	}
	out := make([]T, n)
	for i := 0; i < n; i++ {
		out[i] = src[len(src)-1-i]
	}
	return out
}

var _ Store = (*Memory)(nil)
