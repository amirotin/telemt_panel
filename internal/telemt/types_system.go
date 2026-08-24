package telemt

// Reload mode/failure-policy string constants for ReloadRequest — Telemt
// serializes these as snake_case (maestro/reload.rs ReloadMode/ReloadFailurePolicy).
const (
	ReloadModeInstant = "instant"
	ReloadModeDrain   = "drain"

	ReloadFailurePolicyKeepNew  = "keep_new"
	ReloadFailurePolicyRollback = "rollback"
)

// Reload phase string constants — the `state` field of ReloadAccepted and
// ReloadStatus (maestro/reload.rs ReloadPhase).
const (
	ReloadPhaseAccepted   = "accepted"
	ReloadPhasePreparing  = "preparing"
	ReloadPhaseActivating = "activating"
	ReloadPhaseDraining   = "draining"
	ReloadPhaseSucceeded  = "succeeded"
	ReloadPhaseRolledBack = "rolled_back"
	ReloadPhaseFailed     = "failed"
)

// ReadyData is the payload of GET /v1/health/ready. Telemt returns this same
// struct, wrapped in the normal success envelope, on both 200 (ready) and
// 503 (not ready) — Ready field (not the HTTP status) is what tells them apart.
type ReadyData struct {
	Ready            bool   `json:"ready"`
	Status           string `json:"status"`
	Reason           string `json:"reason,omitempty"`
	AdmissionOpen    bool   `json:"admission_open"`
	HealthyUpstreams int    `json:"healthy_upstreams"`
	TotalUpstreams   int    `json:"total_upstreams"`
}

// ReloadRequest is the body of POST /v1/system/reload. Telemt applies
// `#[serde(default)]` to Mode/FailurePolicy when the field is absent from
// the JSON body (defaulting to instant/keep_new) and rejects unknown fields
// (`#[serde(deny_unknown_fields)]`) — Mode/FailurePolicy use omitempty so a
// caller can leave them unset instead of always spelling out the default.
// TimeoutSecs is required when Mode is ReloadModeDrain, forbidden otherwise
// (maestro/reload.rs ReloadRequest::validate).
type ReloadRequest struct {
	Mode          string  `json:"mode,omitempty"`
	TimeoutSecs   *uint64 `json:"timeout_secs,omitempty"`
	FailurePolicy string  `json:"failure_policy,omitempty"`
}

// ReloadAccepted is the 202 payload of POST /v1/system/reload.
type ReloadAccepted struct {
	ReloadID         uint64 `json:"reload_id"`
	TargetGeneration uint64 `json:"target_generation"`
	ConfigRevision   string `json:"config_revision"`
	State            string `json:"state"`
	Mode             string `json:"mode"`
	FailurePolicy    string `json:"failure_policy"`
}

// ReloadStatus is the payload of GET /v1/system/reload/{id} — polled until
// State reaches a terminal phase (succeeded/rolled_back/failed). Telemt
// keeps the last 32 reload operations (07-telemt-sdk.md §System).
type ReloadStatus struct {
	ReloadID              uint64   `json:"reload_id"`
	TargetGeneration      uint64   `json:"target_generation"`
	ConfigRevision        string   `json:"config_revision"`
	State                 string   `json:"state"`
	Mode                  string   `json:"mode"`
	FailurePolicy         string   `json:"failure_policy"`
	RequestedAtEpochSecs  int64    `json:"requested_at_epoch_secs"`
	StartedAtEpochSecs    *int64   `json:"started_at_epoch_secs,omitempty"`
	FinishedAtEpochSecs   *int64   `json:"finished_at_epoch_secs,omitempty"`
	DeferredProcessFields []string `json:"deferred_process_fields,omitempty"`
	Warnings              []string `json:"warnings,omitempty"`
	Error                 string   `json:"error,omitempty"`
}
