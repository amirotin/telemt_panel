// Package store defines the panel's state layer: sessions, audit log,
// update journal, metric history and subpage nonces. The Memory driver
// implements Store for the router profile; a SQLite driver (vps profile,
// metric history) is a later milestone and must slot in behind the same
// interface without changing callers.
package store

import "time"

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
	Action  string
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
	TS    int64
	Value float64
}

// Store is the panel's state backend. All methods are safe for concurrent
// use. GetSession's bool return reports whether a session with the given
// hash exists; it is false (with a nil error) on a plain miss.
type Store interface {
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
	// MetricRange returns the points of the named series with TS >= fromTS,
	// oldest first.
	MetricRange(name string, fromTS int64) ([]MetricPoint, error)

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
