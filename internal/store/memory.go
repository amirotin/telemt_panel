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

// touchStateDebounce caps how often a TouchSession-triggered state-file write
// happens: at most once per this interval, however many touches land in
// between.
const touchStateDebounce = 30 * time.Second

// Memory is the local control-plane state implementation and the bounded
// history implementation used by the memory profile. Separate instances are
// composed at runtime: the state instance persists sessions, settings, auth,
// policies, audit and update recovery to JSON, while the history instance
// keeps metrics/events for this process only.
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

	statePath string

	// Touch debounce: TouchSession marks the state file dirty and defers the
	// write to a timer that fires at most once per stateDebounce, instead
	// of writing on every touch. All other mutations still write through
	// saveStateLocked immediately. scheduleTimer is the injection point
	// tests use to control the timer deterministically, without real
	// waits; it returns a stop func, mirroring time.Timer.Stop.
	stateDebounce  time.Duration
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

// StateDurable reports whether this state instance writes panel-state.json.
func (m *Memory) StateDurable() bool { return m.statePath != "" }

// stateFile is the on-disk shape of the local control-plane state.
type stateFile struct {
	Sessions            map[string]Session              `json:"sessions"`
	SubpageNonces       map[string]string               `json:"subpage_nonces"`
	Settings            map[string]string               `json:"settings"`
	Journal             map[string][]UpdateJournalEntry `json:"journal"`
	Policies            []StoragePolicy                 `json:"storage_policies,omitempty"`
	Audit               []AuditEntry                    `json:"audit,omitempty"`
	TOTP                TOTPState                       `json:"totp,omitempty"`
	RecoveryCodes       []string                        `json:"totp_recovery_codes,omitempty"`
	WebAuthnUserHandle  []byte                          `json:"webauthn_user_handle,omitempty"`
	WebAuthnCredentials map[string]WebAuthnCredential   `json:"webauthn_credentials,omitempty"`
	// Kept only so state files written by the pre-split development build can
	// be decoded. In-flight ceremonies are deliberately discarded on startup.
	WebAuthnChallenges map[string]WebAuthnChallenge `json:"webauthn_challenges,omitempty"`
}

// NewState opens the mandatory local control-plane state file.
func NewState(path string) (*Memory, error) {
	return NewMemory(path)
}

// NewMemoryHistory creates a bounded, process-local history store.
func NewMemoryHistory() (*Memory, error) {
	return NewMemory("")
}

// NewMemory creates a memory-backed Store. If statePath is non-empty,
// control-plane state is loaded from it now and persisted back on every
// subsequent mutation (session touches are debounced). A
// missing state file starts empty. An existing unreadable or corrupt file fails
// startup: otherwise damaged persisted TOTP state could silently disappear and
// weaken authentication.
func NewMemory(statePath string) (*Memory, error) {
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
		statePath:           statePath,
		stateDebounce:       touchStateDebounce,
		scheduleTimer: func(d time.Duration, f func()) func() {
			t := time.AfterFunc(d, f)
			return func() { t.Stop() }
		},
	}

	if statePath == "" {
		return m, nil
	}

	data, err := os.ReadFile(statePath)
	if err != nil {
		if os.IsNotExist(err) {
			return m, nil
		}
		return nil, fmt.Errorf("store: state file is unreadable: %w", err)
	}

	var mf stateFile
	if err := json.Unmarshal(data, &mf); err != nil {
		return nil, fmt.Errorf("store: state file is corrupt: %w", err)
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
			slog.Warn("store: state-file storage policies invalid, using defaults", "path", statePath, "error", err)
		} else {
			m.policies = policyMap(mf.Policies)
		}
	}
	if len(mf.Audit) > auditCap {
		mf.Audit = mf.Audit[len(mf.Audit)-auditCap:]
	}
	m.audit = append([]AuditEntry(nil), mf.Audit...)
	m.pruneAuditLocked(time.Now())
	if mf.Journal != nil {
		// Defensive ring-cap truncation: the persisted file is trusted
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
			return nil, fmt.Errorf("store: state file contains an invalid TOTP recovery hash")
		}
		if _, duplicate := m.recoveryCodes[hash]; duplicate {
			return nil, fmt.Errorf("store: state file contains a duplicate TOTP recovery hash")
		}
		m.recoveryCodes[hash] = struct{}{}
	}
	if err := validatePortableTOTP(m.totp, recoveryCodeHashes(m.recoveryCodes)); err != nil {
		return nil, fmt.Errorf("store: state file contains invalid TOTP state: %w", err)
	}
	m.totp.RecoveryCodes = len(m.recoveryCodes)
	m.webauthnUserHandle = append([]byte(nil), mf.WebAuthnUserHandle...)
	if mf.WebAuthnCredentials != nil {
		m.webauthnCredentials = cloneWebAuthnCredentials(mf.WebAuthnCredentials)
	}
	if err := validatePortableWebAuthn(m.webauthnUserHandle, m.webauthnCredentials, nil); err != nil {
		return nil, fmt.Errorf("store: state file contains invalid WebAuthn state: %w", err)
	}
	return m, nil
}

// saveStateLocked is the best-effort path used only for debounced LastSeen
// updates. Security-sensitive and administrative mutations call
// writeStateLocked directly and return persistence failures to the caller.
func (m *Memory) saveStateLocked() {
	if err := m.writeStateLocked(); err != nil {
		slog.Warn("store: state-file write failed", "path", m.statePath, "error", err)
	}
}

// writeStateLocked persists control-plane state as temp + fsync + rename,
// mode 0600. Callers must hold mu.
func (m *Memory) writeStateLocked() error {
	if m.statePath == "" {
		return nil
	}

	mf := stateFile{
		Sessions:            m.sessions,
		SubpageNonces:       m.subpageNonces,
		Settings:            m.settings,
		Journal:             m.journal,
		Policies:            policiesFromMap(m.policies),
		Audit:               m.audit,
		TOTP:                m.totp,
		RecoveryCodes:       recoveryCodeKeys(m.recoveryCodes),
		WebAuthnUserHandle:  append([]byte(nil), m.webauthnUserHandle...),
		WebAuthnCredentials: m.webauthnCredentials,
	}
	data, err := json.Marshal(mf)
	if err != nil {
		return fmt.Errorf("encode state file: %w", err)
	}

	dir := filepath.Dir(m.statePath)
	tmp, err := os.CreateTemp(dir, ".panel-state-*.tmp")
	if err != nil {
		return fmt.Errorf("create state temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once renamed

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write state file: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("sync state file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close state file: %w", err)
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		return fmt.Errorf("secure state file: %w", err)
	}
	if err := os.Rename(tmpName, m.statePath); err != nil {
		return fmt.Errorf("replace state file: %w", err)
	}
	directory, err := os.Open(dir)
	if err != nil {
		slog.Warn("store: state directory sync skipped", "path", dir, "error", err)
		return nil
	}
	if err := directory.Sync(); err != nil {
		_ = directory.Close()
		slog.Warn("store: state directory sync failed", "path", dir, "error", err)
		return nil
	}
	if err := directory.Close(); err != nil {
		slog.Warn("store: state directory close failed", "path", dir, "error", err)
	}
	return nil
}

// PutSession creates or replaces the session keyed by s.IDHash.
func (m *Memory) PutSession(s Session) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	previous, existed := m.sessions[s.IDHash]
	m.sessions[s.IDHash] = s
	if err := m.writeStateLocked(); err != nil {
		if existed {
			m.sessions[s.IDHash] = previous
		} else {
			delete(m.sessions, s.IDHash)
		}
		return err
	}
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
// that does not exist is not an error. The state-file write is debounced (see
// stateDebounce) rather than immediate, since touches happen far more
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
	m.scheduleStateLocked()
	return nil
}

// scheduleStateLocked marks the state file dirty and, if no flush is already
// scheduled, arms a timer to flush it after stateDebounce. Callers must
// hold mu.
func (m *Memory) scheduleStateLocked() {
	if m.statePath == "" {
		return
	}
	m.touchDirty = true
	if m.stopTouchTimer != nil {
		return // a flush is already scheduled for this window
	}
	m.stopTouchTimer = m.scheduleTimer(m.stateDebounce, m.flushTouch)
}

// flushTouch is the debounce timer callback: it writes the state file if state
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
	m.saveStateLocked()
}

// DeleteSession removes one session.
func (m *Memory) DeleteSession(idHash string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	previous, existed := m.sessions[idHash]
	delete(m.sessions, idHash)
	if err := m.writeStateLocked(); err != nil {
		if existed {
			m.sessions[idHash] = previous
		}
		return err
	}
	return nil
}

// DeleteOtherSessions removes every session except keepIDHash.
func (m *Memory) DeleteOtherSessions(keepIDHash string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	previous := make(map[string]Session, len(m.sessions))
	for hash, session := range m.sessions {
		previous[hash] = session
	}
	for hash := range m.sessions {
		if hash != keepIDHash {
			delete(m.sessions, hash)
		}
	}
	if err := m.writeStateLocked(); err != nil {
		m.sessions = previous
		return err
	}
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
	if e.TS.IsZero() {
		e.TS = time.Now().UTC()
	}
	previous := append([]AuditEntry(nil), m.audit...)
	m.audit = append(m.audit, e)
	m.pruneAuditLocked(time.Now())
	if len(m.audit) > auditCap {
		m.audit = m.audit[len(m.audit)-auditCap:]
	}
	if err := m.writeStateLocked(); err != nil {
		m.audit = previous
		return err
	}
	return nil
}

func (m *Memory) pruneAuditLocked(now time.Time) {
	policy := m.policies[StorageAudit]
	if !policy.Enabled || len(m.audit) == 0 {
		return
	}
	cutoff := now.Add(-retentionDuration(policy))
	kept := m.audit[:0]
	for _, entry := range m.audit {
		if entry.TS.IsZero() || !entry.TS.Before(cutoff) {
			kept = append(kept, entry)
		}
	}
	m.audit = kept
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
// TouchSession, this writes through to the state file immediately rather than
// via the debounce timer: update runs are rare events (not a hot path like
// session touches), so there is no flash-wear concern, and durability
// matters more here — this is the exact state ReconcileStartup depends on
// after a restart.
func (m *Memory) AppendUpdateJournal(e UpdateJournalEntry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	previous := append([]UpdateJournalEntry(nil), m.journal[e.Target]...)
	entries := append(append([]UpdateJournalEntry(nil), previous...), e)
	if len(entries) > journalCap {
		entries = entries[len(entries)-journalCap:]
	}
	m.journal[e.Target] = entries
	if err := m.writeStateLocked(); err != nil {
		if previous == nil {
			delete(m.journal, e.Target)
		} else {
			m.journal[e.Target] = previous
		}
		return err
	}
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
// durable history. The memory profile keeps at most one day of 15-minute
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
	previous := m.policies
	previousAudit := append([]AuditEntry(nil), m.audit...)
	m.policies = policyMap(policies)
	m.pruneAuditLocked(time.Now())
	if err := m.writeStateLocked(); err != nil {
		m.policies = previous
		m.audit = previousAudit
		return err
	}
	return nil
}

// ApplyStoragePolicies configures this instance as a history backend without
// persisting the policy copy. The authoritative policy set belongs to the
// state store.
func (m *Memory) ApplyStoragePolicies(policies []StoragePolicy) error {
	if err := ValidateStoragePolicies(policies); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.policies = policyMap(policies)
	return nil
}

func (m *Memory) rollbackImportedHistory() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.metrics = make(map[string][]MetricPoint)
	m.events = nil
	m.nextEventID = 0
	return nil
}

// PurgeAudit removes the bounded administrative audit from local state.
func (m *Memory) PurgeAudit() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	previous := m.audit
	m.audit = nil
	if err := m.writeStateLocked(); err != nil {
		m.audit = previous
		return err
	}
	return nil
}

// PurgeHistory removes the selected in-memory history family.
func (m *Memory) PurgeHistory(category StorageCategory) error {
	if _, ok := defaultPolicyMap()[category]; !ok {
		return fmt.Errorf("unknown storage category %q", category)
	}
	if category == StorageAudit {
		return m.PurgeAudit()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
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
	previous, existed := m.subpageNonces[username]
	m.subpageNonces[username] = nonce
	if err := m.writeStateLocked(); err != nil {
		if existed {
			m.subpageNonces[username] = previous
		} else {
			delete(m.subpageNonces, username)
		}
		return err
	}
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
	previous, existed := m.settings[key]
	m.settings[key] = value
	if err := m.writeStateLocked(); err != nil {
		if existed {
			m.settings[key] = previous
		} else {
			delete(m.settings, key)
		}
		return err
	}
	return nil
}

// Close stops any pending touch-debounce timer and flushes an owed LastSeen
// update synchronously before returning.
func (m *Memory) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.stopTouchTimer != nil {
		m.stopTouchTimer()
		m.stopTouchTimer = nil
	}
	if m.touchDirty {
		m.touchDirty = false
		return m.writeStateLocked()
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
