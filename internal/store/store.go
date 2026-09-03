// Package store defines the panel's durable state and optional history layer.
package store

import (
	"errors"
	"time"
)

var (
	ErrTOTPAlreadyEnabled         = errors.New("TOTP is already enabled")
	ErrTOTPSetupInvalid           = errors.New("TOTP setup is missing, expired, or replaced")
	ErrTOTPReplay                 = errors.New("TOTP timestep was already used")
	ErrRecoveryCode               = errors.New("recovery code is invalid or already used")
	ErrWebAuthnCredentialExists   = errors.New("WebAuthn credential already exists")
	ErrWebAuthnCredentialNotFound = errors.New("WebAuthn credential not found")
	ErrWebAuthnCredentialChanged  = errors.New("WebAuthn credential changed concurrently")
	ErrWebAuthnChallenge          = errors.New("WebAuthn challenge is missing, expired, or already used")
	ErrWebAuthnChallengeLimit     = errors.New("too many active WebAuthn challenges")
)

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

// TOTPState is the complete server-side second-factor state. Secret fields
// never leave the store/auth boundary; HTTP responses expose only Enabled.
type TOTPState struct {
	Enabled        bool      `json:"enabled"`
	Secret         string    `json:"secret,omitempty"`
	PendingSecret  string    `json:"pending_secret,omitempty"`
	PendingExpires time.Time `json:"pending_expires,omitempty"`
	LastTimestep   int64     `json:"last_timestep"`
	RecoveryCodes  int       `json:"recovery_codes"`
}

// WebAuthnCredential is the driver-neutral credential record. CredentialData
// is the JSON-encoded go-webauthn credential; ID and SignCount are duplicated
// as lookup/CAS columns so authentication never relies on a read-modify-write
// race. Secret private key material remains in the authenticator.
type WebAuthnCredential struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	CredentialData []byte    `json:"credential_data"`
	SignCount      uint32    `json:"sign_count"`
	Created        time.Time `json:"created"`
	LastUsed       time.Time `json:"last_used,omitempty"`
}

// WebAuthnChallenge holds a one-time ceremony between begin and finish. The
// externally visible flow ID is hashed before it reaches the store.
type WebAuthnChallenge struct {
	FlowHash    string    `json:"flow_hash"`
	Kind        string    `json:"kind"`
	SessionData []byte    `json:"session_data"`
	Origin      string    `json:"origin"`
	RPID        string    `json:"rp_id"`
	Expires     time.Time `json:"expires"`
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

// UserTrafficDelta is the non-zero traffic observed for one Telemt user
// since the previous users snapshot. Stores aggregate these deltas directly
// into sparse 15-minute and hourly buckets; raw per-poll user history is never
// persisted.
type UserTrafficDelta struct {
	Username string
	TS       int64
	Bytes    uint64
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
	MetricTierHour    MetricTier = "1h"
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

	// GetTOTPState returns the enabled factor or a pending setup, if present.
	GetTOTPState() (TOTPState, error)
	// BeginTOTPSetup replaces an unconfirmed setup while TOTP is disabled.
	BeginTOTPSetup(secret string, expires time.Time) error
	// EnableTOTP atomically promotes the expected, unexpired pending secret,
	// and installs one-time recovery hashes. Setup confirmation is not a login,
	// so it does not consume a replay-protected timestep.
	EnableTOTP(expectedSecret string, now time.Time, recoveryHashes [][]byte) error
	// DisableTOTP atomically removes the factor, pending setup and recovery codes.
	DisableTOTP() error
	// AcceptTOTPTimestep advances the replay watermark exactly once.
	AcceptTOTPTimestep(timestep int64) error
	// ConsumeRecoveryCode atomically removes one matching backup-code hash.
	ConsumeRecoveryCode(hash []byte) error

	// GetOrCreateWebAuthnUserHandle returns the stable opaque user handle,
	// installing candidate atomically when this is the first passkey ceremony.
	GetOrCreateWebAuthnUserHandle(candidate []byte) ([]byte, error)
	ListWebAuthnCredentials() ([]WebAuthnCredential, error)
	GetWebAuthnCredential(id string) (WebAuthnCredential, bool, error)
	AddWebAuthnCredential(credential WebAuthnCredential) error
	DeleteWebAuthnCredential(id string) error
	// UpdateWebAuthnCredential atomically replaces a credential only when its
	// persisted signature counter still equals oldSignCount.
	UpdateWebAuthnCredential(credential WebAuthnCredential, oldSignCount uint32) error
	PutWebAuthnChallenge(challenge WebAuthnChallenge) error
	// ConsumeWebAuthnChallenge atomically removes and returns one matching,
	// unexpired challenge. Every finish attempt therefore spends the challenge.
	ConsumeWebAuthnChallenge(flowHash, kind string, now time.Time) (WebAuthnChallenge, error)

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
	// RecordUserTraffic aggregates non-zero per-user deltas into sparse
	// 15-minute and hourly buckets when user traffic history is enabled.
	RecordUserTraffic(deltas []UserTrafficDelta) error
	// UserTrafficRange returns one non-overlapping resolution for a user,
	// oldest first. The user name is treated as an opaque identity.
	UserTrafficRange(username string, fromTS int64) ([]MetricPoint, error)
	// UserTrafficRetention reports the effective reach of per-user history.
	UserTrafficRetention() time.Duration
	// DeleteUserHistory removes every optional history row owned by a user.
	DeleteUserHistory(username string) error

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
