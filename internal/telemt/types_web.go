package telemt

import (
	"encoding/json"
	"fmt"
)

// Telemt error codes specific to the WEB runtime group (Telemt >= 3.5.3,
// verified against 3.5.5 `src/api/web_runtime.rs`). Named here rather than
// spelled as literals at each call site so the panel's mapping of a WEB
// failure to an HTTP status has one vocabulary — 07-telemt-sdk.md §"WEB
// runtime".
const (
	// CodeWebRuntimeUnavailable (503) — the WEB runtime is not in a state
	// that can answer: no WEB listener configured, still starting, drained.
	// The message carries the lifecycle token; the panel reports this as a
	// closed capability with a reason, never as an error (rule R5).
	CodeWebRuntimeUnavailable = "web_runtime_unavailable"
	// CodeWebSnapshotBusy (503) — a per-session or manager lock was
	// contended for an exact lookup. The next poll answers.
	CodeWebSnapshotBusy = "web_snapshot_busy"
	// CodeWebRuntimeMismatch (409) — the runtime_instance/session_ref/
	// cursor/operation_id belongs to a previous Telemt process. This is the
	// process fence: a close request built against a restarted proxy is
	// refused rather than applied to whatever now holds those ids.
	CodeWebRuntimeMismatch = "web_runtime_mismatch"
	// CodeWebIssuanceEnabled (409) — the `all` close selector was submitted
	// while WEB issuance is still enabled.
	CodeWebIssuanceEnabled = "web_issuance_enabled"
	// CodeWebOperationInProgress (409) — one close operation runs at a time.
	CodeWebOperationInProgress = "web_operation_in_progress"
	// CodeWebSessionNotFound (404) — a canonical ref with neither a live
	// session nor a retained tombstone behind it.
	CodeWebSessionNotFound = "web_session_not_found"
	// CodeWebOperationNotFound (404) — a canonical operation id outside the
	// 32 statuses Telemt retains.
	CodeWebOperationNotFound = "web_operation_not_found"
	// CodeUnsupportedMediaType (415) — the POST routes require exactly one
	// `Content-Type: application/json` header, byte-exact (no charset).
	CodeUnsupportedMediaType = "unsupported_media_type"
)

// WEB session lifecycle/state enums, as Telemt spells them on the wire.
// Listed rather than typed as a Go enum: an unknown future value must pass
// through to the browser unchanged, never be rejected at decode time.
const (
	WebLifecycleStarting         = "starting"
	WebLifecycleNoWebListener    = "no_web_listener"
	WebLifecycleRunning          = "running"
	WebLifecycleDraining         = "draining"
	WebLifecycleDrained          = "drained"
	WebLifecycleDeadlineExceeded = "deadline_exceeded"
)

// WebStatusData is the payload of GET /v1/runtime/web/status — the WEB
// runtime's process view (GET /v1/config is the desired view).
//
// This route NEVER answers 503: a build with WEB off replies 200 with
// Available=false and a Reason token (api/web_runtime.rs's
// `web_status_data`), so the capability gate the panel shows is read off
// these fields rather than from an error. The 503 web_runtime_unavailable
// path belongs to the sessions/close/operations routes.
type WebStatusData struct {
	Lifecycle      string `json:"lifecycle"`
	LifecycleEpoch uint64 `json:"lifecycle_epoch"`
	// LifecycleAgeMs re-reads the clock on every request, so the hub
	// deliberately excludes it from push-on-change (internal/hub diffKey).
	LifecycleAgeMs uint64 `json:"lifecycle_age_ms"`
	Available      bool   `json:"available"`
	// Reason is omitted while Available is true. Values: starting,
	// no_web_listener, runtime_released, drained, deadline_exceeded —
	// note runtime_released is a reason, not a lifecycle.
	Reason                 string            `json:"reason,omitempty"`
	Listeners              []string          `json:"listeners"`
	EffectiveConfigEnabled bool              `json:"effective_config_enabled"`
	Runtime                *WebRuntimeStatus `json:"runtime,omitempty"`
}

// WebRuntimeStatus is the live process state behind WebStatusData.Runtime.
//
// The six plane fields carry NO omitempty on Telemt's side and arrive as an
// explicit JSON null whenever that plane's try_lock was contended; the same
// plane names are then listed in Partial. Pointers here reproduce that
// exactly — a nil plane is "busy this poll", not "absent from this build".
type WebRuntimeStatus struct {
	RuntimeInstance string          `json:"runtime_instance"`
	GenerationID    uint64          `json:"generation_id"`
	Limits          json.RawMessage `json:"limits"`

	Manager    *WebManagerStatus  `json:"manager"`
	Streams    *WebStreamStatus   `json:"streams"`
	Budget     *WebBudgetStatus   `json:"budget"`
	Websockets *WebSocketStatus   `json:"websockets"`
	Learning   *WebLearningStatus `json:"learning"`
	Debug      *WebDebugStatus    `json:"debug"`
	Permits    []WebPermit        `json:"permits"`

	AuxiliaryTasks             int    `json:"auxiliary_tasks"`
	SessionIncarnationsCreated uint64 `json:"session_incarnations_created"`
	SessionIncarnationsClosed  uint64 `json:"session_incarnations_closed"`
	StreamsOpened              uint64 `json:"streams_opened"`
	StreamsRejected            uint64 `json:"streams_rejected"`
	BytesUp                    uint64 `json:"bytes_up"`
	BytesDown                  uint64 `json:"bytes_down"`
	LimitHits                  uint64 `json:"limit_hits"`
	// Partial names the planes that are null above, in Telemt's own fixed
	// order: manager, streams, budget, websockets, learning, debug.
	Partial []string `json:"partial"`
}

// WebPermitStatus is one semaphore's occupancy.
type WebPermitStatus struct {
	Used      int  `json:"used"`
	Available int  `json:"available"`
	Capacity  int  `json:"capacity"`
	Closed    bool `json:"closed"`
}

// WebPermit is one entry of WebRuntimeStatus.Permits.
//
// On the wire this is a Rust tuple, i.e. a two-element JSON ARRAY
// ["http_connections", {...}] — not an object and not a map. The custom
// codec below keeps the panel's re-marshalled topic payload byte-compatible
// with Telemt's own shape instead of quietly inventing a third spelling;
// the frontend adapter is where it becomes a keyed object for rendering.
type WebPermit struct {
	Name   string
	Status WebPermitStatus
}

// UnmarshalJSON decodes the ["name", {...}] tuple form.
func (p *WebPermit) UnmarshalJSON(data []byte) error {
	var tuple []json.RawMessage
	if err := json.Unmarshal(data, &tuple); err != nil {
		return fmt.Errorf("telemt: decode web permit: %w", err)
	}
	if len(tuple) != 2 {
		return fmt.Errorf("telemt: decode web permit: got %d tuple elements, want 2", len(tuple))
	}
	if err := json.Unmarshal(tuple[0], &p.Name); err != nil {
		return fmt.Errorf("telemt: decode web permit name: %w", err)
	}
	if err := json.Unmarshal(tuple[1], &p.Status); err != nil {
		return fmt.Errorf("telemt: decode web permit %q: %w", p.Name, err)
	}
	return nil
}

// MarshalJSON re-encodes the tuple form, so a decode/encode round trip
// through the hub preserves Telemt's shape.
func (p WebPermit) MarshalJSON() ([]byte, error) {
	return json.Marshal([]any{p.Name, p.Status})
}

// WebManagerStatus is the session/bootstrap registry plane. IssuanceEnabled
// is the flag the `all` close selector requires to be false.
type WebManagerStatus struct {
	IssuanceEnabled    bool   `json:"issuance_enabled"`
	IssuanceGeneration uint64 `json:"issuance_generation"`
	Shutdown           bool   `json:"shutdown"`
	Bootstraps         int    `json:"bootstraps"`
	Sessions           int    `json:"sessions"`
	ClosedTokens       int    `json:"closed_tokens"`
	ClosedSessions     int    `json:"closed_sessions"`
	ClientIPs          int    `json:"client_ips"`
	Profiles           int    `json:"profiles"`
}

// WebStreamStatus is the logical-stream plane.
type WebStreamStatus struct {
	Live     int  `json:"live"`
	Profiles int  `json:"profiles"`
	Closed   bool `json:"closed"`
}

// WebBudgetStatus is the queue/control byte budget plane.
type WebBudgetStatus struct {
	QueueBytes     int  `json:"queue_bytes"`
	QueueItems     int  `json:"queue_items"`
	ControlBytes   int  `json:"control_bytes"`
	ControlItems   int  `json:"control_items"`
	WebsocketBytes int  `json:"websocket_bytes"`
	HighWaterBytes int  `json:"high_water_bytes"`
	Owners         int  `json:"owners"`
	Closed         bool `json:"closed"`
}

// WebSocketStatus is the WebSocket admission/eviction plane.
type WebSocketStatus struct {
	Entries           int  `json:"entries"`
	Claims            int  `json:"claims"`
	EvictionsInFlight int  `json:"evictions_in_flight"`
	Closed            bool `json:"closed"`
}

// WebLearningStatus is the carrier-learning plane. Epoch is nullable but
// always present on the wire.
type WebLearningStatus struct {
	Enabled        bool    `json:"enabled"`
	Aggressiveness string  `json:"aggressiveness"`
	Epoch          *uint64 `json:"epoch"`
	Entries        int     `json:"entries"`
	Capacity       int     `json:"capacity"`
	LifetimeSecs   uint64  `json:"lifetime_secs"`
	AgeMs          uint64  `json:"age_ms"`
}

// WebDebugStatus is the request-capture plane. Policy is passed through
// opaquely: it is a config block Telemt owns, the panel neither edits nor
// interprets it, and a future key must survive the round trip untouched
// (same invariant as ConfigSections).
type WebDebugStatus struct {
	Policy           json.RawMessage `json:"policy"`
	PolicyGeneration uint64          `json:"policy_generation"`
	Epoch            uint64          `json:"epoch"`
	Records          int             `json:"records"`
	RecordsCapacity  int             `json:"records_capacity"`
	UsedBytes        int             `json:"used_bytes"`
	BytesCapacity    int             `json:"bytes_capacity"`
	ContentionDrops  uint64          `json:"contention_drops"`
	Evictions        uint64          `json:"evictions"`
	ByteTruncations  uint64          `json:"byte_truncations"`
	EarliestSeq      *uint64         `json:"earliest_seq"`
	LatestSeq        *uint64         `json:"latest_seq"`
}

// WebSessionStatus is the 23-field status block of one live WEB session
// (src/web/session/status.rs). It is FLATTENED into WebSessionRow on the
// wire (`#[serde(flatten)]`), which the embedded field below reproduces.
type WebSessionStatus struct {
	TraceSessionID            uint64 `json:"trace_session_id"`
	ClientIP                  string `json:"client_ip"`
	Host                      string `json:"host"`
	User                      string `json:"user"`
	KeyID                     string `json:"key_id"`
	Carrier                   string `json:"carrier"`
	Attempt                   uint8  `json:"attempt"`
	ClientClass               string `json:"client_class"`
	Automatic                 bool   `json:"automatic"`
	State                     string `json:"state"`
	Streams                   int    `json:"streams"`
	Tasks                     int    `json:"tasks"`
	Lanes                     int    `json:"lanes"`
	LaneOpenWaits             int    `json:"lane_open_waits"`
	WebsocketLaneReservations int    `json:"websocket_lane_reservations"`
	WebsocketActive           bool   `json:"websocket_active"`
	PendingBytes              int    `json:"pending_bytes"`
	PendingItems              int    `json:"pending_items"`
	ControlBytes              int    `json:"control_bytes"`
	ControlItems              int    `json:"control_items"`
	AgeMs                     uint64 `json:"age_ms"`
	IdleMs                    uint64 `json:"idle_ms"`
	// NegotiationRemainingMs is omitted once the carrier chain is settled.
	NegotiationRemainingMs *uint64 `json:"negotiation_remaining_ms,omitempty"`
}

// WebSessionRow is one row of the sessions page and the 200 body of
// GET /v1/runtime/web/sessions/{ref}: the opaque ref, the optional
// user-agent pair, and the flattened status fields.
type WebSessionRow struct {
	SessionRef  string `json:"session_ref"`
	UserAgent   string `json:"user_agent,omitempty"`
	UserAgentID string `json:"user_agent_id,omitempty"`
	WebSessionStatus
}

// WebSessionPage is the payload of GET /v1/runtime/web/sessions. There is
// no total: the scan is bounded (Telemt caps it at 1000 candidates) and
// paging is by opaque cursor.
//
// A contended manager lock is NOT an error here: Telemt answers 200 with an
// empty page and Partial=["manager"], which the page renders as "busy",
// never as "no sessions".
type WebSessionPage struct {
	Sessions        []WebSessionRow `json:"sessions"`
	NextCursor      *string         `json:"next_cursor"`
	Scanned         int             `json:"scanned"`
	ScanTruncated   bool            `json:"scan_truncated"`
	PartialSessions int             `json:"partial_sessions"`
	Partial         []string        `json:"partial"`
}

// WebSessionClosed is the 410 tombstone Telemt returns inside an ORDINARY
// success envelope for a session that has already closed but whose record
// is retained. It is a result, not an error — see Client.WebSession.
type WebSessionClosed struct {
	SessionRef string `json:"session_ref"`
	State      string `json:"state"`
	Attempt    uint8  `json:"attempt"`
}

// WebSessionResult is the three-way outcome of GET
// /v1/runtime/web/sessions/{ref}: a live row, a closed-session tombstone,
// or (as an error, not here) 404/503.
type WebSessionResult struct {
	Row    *WebSessionRow    `json:"row,omitempty"`
	Closed *WebSessionClosed `json:"closed,omitempty"`
}

// WEB close selector kinds (POST /v1/runtime/web/sessions/close).
const (
	WebCloseSelectorRefs   = "refs"
	WebCloseSelectorFilter = "filter"
	WebCloseSelectorAll    = "all"
)

// WebCloseSelector is the internally-tagged selector of a close request.
// Exactly one shape is valid per Kind; the unused fields are omitted, which
// matters because Telemt decodes this with `deny_unknown_fields`.
type WebCloseSelector struct {
	Kind string `json:"kind"`
	// refs: 1..200 canonical refs, no duplicates.
	SessionRefs []string `json:"session_refs,omitempty"`
	// filter: at least one of these must be set.
	SessionRef  string `json:"session_ref,omitempty"`
	IP          string `json:"ip,omitempty"`
	Host        string `json:"host,omitempty"`
	User        string `json:"user,omitempty"`
	UserAgentID string `json:"user_agent_id,omitempty"`
	KeyID       string `json:"key_id,omitempty"`
	Carrier     string `json:"carrier,omitempty"`
	State       string `json:"state,omitempty"`
}

// WebCloseRequest is the body of POST /v1/runtime/web/sessions/close.
// RuntimeInstance is the process fence and is mandatory.
type WebCloseRequest struct {
	RuntimeInstance string           `json:"runtime_instance"`
	Selector        WebCloseSelector `json:"selector"`
}

// WEB control operation states (GET /v1/runtime/web/operations/{id}).
const (
	WebOperationQueued    = "queued"
	WebOperationRunning   = "running"
	WebOperationCompleted = "completed"
	WebOperationCancelled = "cancelled"
	WebOperationFailed    = "failed"
)

// WebControlOperationStatus is the 202 body of the close request and the
// 200 body of the operation poll — the same struct on both.
type WebControlOperationStatus struct {
	OperationID         string  `json:"operation_id"`
	State               string  `json:"state"`
	HighWaterSessionRef *string `json:"high_water_session_ref"`
	// Requested is the explicit ref count for a `refs` selector and 0 for
	// `filter`/`all`, which have no up-front size.
	Requested          int    `json:"requested"`
	Scanned            int    `json:"scanned"`
	Matched            int    `json:"matched"`
	CloseSignalled     int    `json:"close_signalled"`
	Conflicted         int    `json:"conflicted"`
	CreatedEpochMillis uint64 `json:"created_epoch_millis"`
	UpdatedEpochMillis uint64 `json:"updated_epoch_millis"`
	Failure            string `json:"failure,omitempty"`
}

// IsWebOperationTerminal reports whether an operation state can no longer
// change — what stops the panel's poll loop.
func IsWebOperationTerminal(state string) bool {
	switch state {
	case WebOperationCompleted, WebOperationCancelled, WebOperationFailed:
		return true
	default:
		return false
	}
}
