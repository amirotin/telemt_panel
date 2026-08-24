package store

import (
	"encoding/json"
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
	metricCap  = 900
)

// touchMirrorDebounce caps how often a TouchSession-triggered mirror write
// happens: at most once per this interval, however many touches land in
// between.
const touchMirrorDebounce = 30 * time.Second

// Memory is an in-memory Store for the router profile: no flash writes,
// bounded by ring buffers. Sessions, subpage nonces and settings can
// optionally be mirrored to a JSON file so they survive a process restart;
// audit, update-journal and metric history are process-lifetime only.
type Memory struct {
	mu sync.Mutex

	sessions      map[string]Session
	audit         []AuditEntry
	journal       map[string][]UpdateJournalEntry
	metrics       map[string][]MetricPoint
	subpageNonces map[string]string
	settings      map[string]string

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

// mirrorFile is the on-disk shape of the mirrored subset of state
// (sessions, subpage nonces and settings only).
type mirrorFile struct {
	Sessions      map[string]Session `json:"sessions"`
	SubpageNonces map[string]string  `json:"subpage_nonces"`
	Settings      map[string]string  `json:"settings"`
}

// NewMemory creates an in-memory Store. If mirrorPath is non-empty,
// sessions, subpage nonces and settings are loaded from it now and
// persisted back to it on every subsequent mutation of those families
// (touches are debounced, see touchMirrorDebounce). A missing or corrupt
// mirror file is logged and treated as empty — it never fails startup.
func NewMemory(mirrorPath string) (*Memory, error) {
	m := &Memory{
		sessions:       make(map[string]Session),
		journal:        make(map[string][]UpdateJournalEntry),
		metrics:        make(map[string][]MetricPoint),
		subpageNonces:  make(map[string]string),
		settings:       make(map[string]string),
		mirrorPath:     mirrorPath,
		mirrorDebounce: touchMirrorDebounce,
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
		if !os.IsNotExist(err) {
			slog.Warn("store: mirror file unreadable, starting empty", "path", mirrorPath, "error", err)
		}
		return m, nil
	}

	var mf mirrorFile
	if err := json.Unmarshal(data, &mf); err != nil {
		slog.Warn("store: mirror file corrupt, starting empty", "path", mirrorPath, "error", err)
		return m, nil
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
	return m, nil
}

// saveMirrorLocked writes the mirrored subset of state to mirrorPath as a
// temp file + rename, 0600. Callers must hold mu. Errors are logged, not
// returned — the mirror is a best-effort convenience, not the source of
// truth.
func (m *Memory) saveMirrorLocked() {
	if m.mirrorPath == "" {
		return
	}

	mf := mirrorFile{
		Sessions:      m.sessions,
		SubpageNonces: m.subpageNonces,
		Settings:      m.settings,
	}
	data, err := json.Marshal(mf)
	if err != nil {
		slog.Warn("store: mirror encode failed", "path", m.mirrorPath, "error", err)
		return
	}

	dir := filepath.Dir(m.mirrorPath)
	tmp, err := os.CreateTemp(dir, ".store-mirror-*.tmp")
	if err != nil {
		slog.Warn("store: mirror temp file failed", "path", m.mirrorPath, "error", err)
		return
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once renamed

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		slog.Warn("store: mirror write failed", "path", m.mirrorPath, "error", err)
		return
	}
	if err := tmp.Close(); err != nil {
		slog.Warn("store: mirror close failed", "path", m.mirrorPath, "error", err)
		return
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		slog.Warn("store: mirror chmod failed", "path", m.mirrorPath, "error", err)
		return
	}
	if err := os.Rename(tmpName, m.mirrorPath); err != nil {
		slog.Warn("store: mirror rename failed", "path", m.mirrorPath, "error", err)
	}
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

// AppendUpdateJournal records one update-journal entry for e.Target,
// evicting the oldest for that target if its ring is full.
func (m *Memory) AppendUpdateJournal(e UpdateJournalEntry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	entries := append(m.journal[e.Target], e)
	if len(entries) > journalCap {
		entries = entries[len(entries)-journalCap:]
	}
	m.journal[e.Target] = entries
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
	m.mu.Lock()
	defer m.mu.Unlock()
	points := append(m.metrics[name], p)
	if len(points) > metricCap {
		points = points[len(points)-metricCap:]
	}
	m.metrics[name] = points
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
	return out, nil
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
