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
	TS              int64
	Value           float64
	Tier            MetricTier
	Max             float64
	Samples         int64
	Min             *float64 `json:",omitempty"`
	FirstTS         int64    `json:",omitempty"`
	LastTS          int64    `json:",omitempty"`
	FirstValue      float64  `json:",omitempty"`
	Delta           *float64 `json:",omitempty"`
	ObservedSeconds int64    `json:",omitempty"`
	Gaps            int64    `json:",omitempty"`
}

// NamedMetricPoint is one series key and sample for an atomic batch write.
type NamedMetricPoint struct {
	Name  string
	Point MetricPoint
}

// UserTrafficSourceState describes whether Telemt can currently provide user
// counters. It deliberately does not encode history-backend health.
type UserTrafficSourceState string

const (
	UserTrafficCollecting  UserTrafficSourceState = "collecting"
	UserTrafficPaused      UserTrafficSourceState = "paused"
	UserTrafficUnavailable UserTrafficSourceState = "unavailable"
)

// UserTrafficContinuity records whether the accumulated value has a known
// observation gap larger than the normal collector tolerance.
type UserTrafficContinuity string

const (
	UserTrafficNormal  UserTrafficContinuity = "normal"
	UserTrafficPartial UserTrafficContinuity = "partial"
)

// UserTrafficObservation is one raw Telemt counter in a coherent snapshot.
type UserTrafficObservation struct {
	Username  string
	RawOctets uint64
}

// UserTrafficSnapshot is accepted only after the Telemt client verifies that
// system, security and users responses belong to one process and revision.
type UserTrafficSnapshot struct {
	ObservedAt       int64
	SourceStartedAt  int64
	TelemetryEnabled bool
	Users            []UserTrafficObservation
}

// UserTrafficSummary is the panel-owned accumulated view of one Telemt
// account. Values describe traffic observed by the panel, not a billing total.
type UserTrafficSummary struct {
	Username               string                `json:"username"`
	ObservedTotalBytes     int64                 `json:"observed_total_bytes"`
	CurrentMonthBytes      int64                 `json:"current_month_bytes"`
	MonthKey               int                   `json:"month_key"`
	ObservedSinceEpochSecs int64                 `json:"observed_since_epoch_secs"`
	LastActivityEpochSecs  int64                 `json:"last_activity_epoch_secs"`
	DeletedEpochSecs       int64                 `json:"deleted_epoch_secs,omitempty"`
	Continuity             UserTrafficContinuity `json:"continuity"`
}

// UserTrafficPoint is one exact, non-cumulative traffic bucket.
type UserTrafficPoint struct {
	TS    int64      `json:"ts"`
	Bytes int64      `json:"bytes"`
	Tier  MetricTier `json:"tier"`
}

type UserTrafficRank struct {
	Username         string                `json:"username"`
	Bytes            int64                 `json:"bytes"`
	ObservedTotal    int64                 `json:"observed_total_bytes"`
	CurrentMonth     int64                 `json:"current_month_bytes"`
	DeletedEpochSecs int64                 `json:"deleted_epoch_secs,omitempty"`
	Continuity       UserTrafficContinuity `json:"continuity"`
}

type UserTrafficRankCursor struct {
	Bytes    int64
	Username string
}

// UserTrafficCollectorState describes the last coherent source observation.
type UserTrafficCollectorState struct {
	LastSuccessTS   int64                  `json:"last_success_epoch_secs"`
	SourceStartedAt int64                  `json:"source_started_at_epoch_secs"`
	SourceState     UserTrafficSourceState `json:"source_state"`
	Continuity      UserTrafficContinuity  `json:"continuity"`
}

// UserTrafficApplyResult reports the aggregate delta committed for a snapshot.
type UserTrafficApplyResult struct {
	DeltaBytes int64
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
	MetricTierFive    MetricTier = "5m"
	MetricTierQuarter MetricTier = "15m"
	MetricTierHour    MetricTier = "1h"
	MetricTierDay     MetricTier = "1d"
	metricTierRawSQL             = "raw"
)

// Store is the application-facing composition of local control-plane state
// and the independently configured observability history backend.
type Store interface {
	StateStore
	HistoryStore
}
