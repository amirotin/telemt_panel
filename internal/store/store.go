// Package store defines the panel's durable state and optional history layer.
package store

import "time"

// Info describes the active store implementation without exposing secrets.
type Info struct {
	Driver   string `json:"driver"`
	Durable  bool   `json:"durable"`
	Remote   bool   `json:"remote"`
	Schema   int    `json:"schema"`
	SizeHint int64  `json:"size_hint"`
}

// Session is an authenticated browser session, keyed by IDHash — the hex
// SHA-256 of the opaque session token. Hashing happens in internal/auth,
// not here; the store only ever sees the hash.
type Session struct {
	IDHash         string
	Created        time.Time
	LastSeen       time.Time
	IP             string
	UserAgentLabel string
	AuthMethod     string
}

// AuditEntry is one record in the admin-action audit log.
type AuditEntry struct {
	TS      time.Time
	ID      string
	Action  string
	Actor   string
	Target  string
	Outcome string
	IP      string
	Subject string
	Detail  string
}

// UpdateJournalEntry records one step of a Telemt or panel self-update run.
type UpdateJournalEntry struct {
	Target      string
	RunID       string
	Phase       string
	VersionFrom string
	VersionTo   string
	TS          time.Time
	Detail      string
}

// MetricPoint is a single timestamped sample in a named metric series.
type MetricPoint struct {
	TS      int64
	Value   float64
	Tier    MetricTier
	Max     float64
	Samples int64
}

// NamedMetricPoint is one series key and sample for an atomic batch write.
type NamedMetricPoint struct {
	Name  string
	Point MetricPoint
}

// HistoryEvent is one safe, structured state transition. Attributes may
// contain small identifiers or numeric context, but never raw logs, IP
// addresses, credentials, endpoint addresses or configuration snapshots.
type HistoryEvent struct {
	ID            int64             `json:"id"`
	TS            time.Time         `json:"ts"`
	Category      StorageCategory   `json:"category"`
	Kind          string            `json:"kind"`
	Entity        string            `json:"entity"`
	State         string            `json:"state"`
	PreviousState string            `json:"previous_state"`
	Severity      string            `json:"severity"`
	Attributes    map[string]string `json:"attributes,omitempty"`
}

// HistoryEventFilter selects stored events. From is inclusive, zero means no
// lower bound, and Limit <= 0 means no explicit cap.
type HistoryEventFilter struct {
	From     time.Time
	Limit    int
	Category StorageCategory
	Kind     string
	Entity   string
}

// MetricTier identifies the resolution of a stored history point. Raw is
// represented by the empty value in the Go/API model for backward-compatible
// portable exports; SQL stores persist it as the explicit "raw" key.
type MetricTier string

const (
	MetricTierRaw     MetricTier = ""
	MetricTierMinute  MetricTier = "1m"
	MetricTierQuarter MetricTier = "15m"
	metricTierRawSQL             = "raw"
)

// Store is the panel's state backend. All methods are safe for concurrent
// use. GetSession's bool return reports whether a session with the given
// hash exists; it is false (with a nil error) on a plain miss.
type Store interface {
	// Driver returns the configured backend name.
	Driver() string
	// Info reports capabilities and schema information for the active backend.
	Info() Info

	// PutSession creates or replaces the session keyed by s.IDHash.
	PutSession(s Session) error
	// GetSession looks up a session by its IDHash. The bool is false when
	// no such session exists; that case is not an error.
	GetSession(idHash string) (Session, bool, error)
	// TouchSession updates LastSeen for the given session, sliding its TTL.
	TouchSession(idHash string, at time.Time) error
	// DeleteSession removes one session. Deleting a session that does not
	// exist is not an error.
	DeleteSession(idHash string) error
	// DeleteOtherSessions removes every session except keepIDHash.
	DeleteOtherSessions(keepIDHash string) error
	// ListSessions returns all sessions ordered by Created, newest first.
	ListSessions() ([]Session, error)

	// AppendAudit records one audit entry, evicting the oldest if the ring
	// is full.
	AppendAudit(e AuditEntry) error
	// ListAudit returns up to limit audit entries, newest first.
	ListAudit(limit int) ([]AuditEntry, error)

	// AppendUpdateJournal records one update-journal entry for e.Target,
	// evicting the oldest for that target if its ring is full.
	AppendUpdateJournal(e UpdateJournalEntry) error
	// ListUpdateJournal returns up to limit entries for target, newest first.
	ListUpdateJournal(target string, limit int) ([]UpdateJournalEntry, error)

	// RecordMetric appends p to the named metric series, evicting the
	// oldest point if the series ring is full.
	RecordMetric(name string, p MetricPoint) error
	// RecordMetrics writes a poll's related samples as one bounded operation.
	RecordMetrics(points []NamedMetricPoint) error
	// MetricRange returns the points of the named series with TS >= fromTS,
	// oldest first.
	MetricRange(name string, fromTS int64) ([]MetricPoint, error)
	// MetricRetention reports the configured retention for a metric. Zero
	// means that persistence for the metric's category is disabled.
	MetricRetention(name string) time.Duration

	// AppendHistoryEvent records one structured transition when its category
	// is enabled.
	AppendHistoryEvent(event HistoryEvent) error
	// ListHistoryEvents returns matching events newest first.
	ListHistoryEvents(filter HistoryEventFilter) ([]HistoryEvent, error)

	// ListStoragePolicies returns every history policy in stable UI order.
	ListStoragePolicies() ([]StoragePolicy, error)
	// ReplaceStoragePolicies atomically replaces the complete policy set.
	ReplaceStoragePolicies(policies []StoragePolicy) error
	// PurgeHistory permanently deletes stored history for category. It does
	// not change whether future records are written.
	PurgeHistory(category StorageCategory) error
	// StorageStats reports the current backend footprint and record counts.
	StorageStats() (StorageStats, error)

	// GetSubpageNonce returns the current subpage nonce for username, or
	// "" if none has been set.
	GetSubpageNonce(username string) (string, error)
	// SetSubpageNonce sets the subpage nonce for username.
	SetSubpageNonce(username, nonce string) error

	// GetSetting returns the value stored under key. The bool is false
	// when no such key exists; that case is not an error.
	GetSetting(key string) (string, bool, error)
	// SetSetting sets the value stored under key, creating or overwriting it.
	SetSetting(key, value string) error

	// Close releases any resources held by the store.
	Close() error
}
