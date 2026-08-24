package telemt

import "encoding/json"

// ConfigSections is the payload of GET /v1/config — the editable Telemt
// config sections as raw JSON, so integers round-trip exactly rather than
// going through a decode/re-encode that could turn a large u64 into a float
// (07-telemt-sdk.md §Config: "Целые числа обязаны переживать round-trip как
// целые"). A section absent from the config file is an absent (nil) field
// here, never an explicit JSON null (API.md: "Sections absent from the
// config file are absent from the response (not null)"). `access` and
// `network` are never returned; under `server` only the nested `listeners`
// allowlist is exposed, which is why Server holds `{"listeners": [...]}`
// rather than the section being split into per-field entries.
type ConfigSections struct {
	General     json.RawMessage `json:"general,omitempty"`
	Timeouts    json.RawMessage `json:"timeouts,omitempty"`
	Censorship  json.RawMessage `json:"censorship,omitempty"`
	Upstreams   json.RawMessage `json:"upstreams,omitempty"`
	DCOverrides json.RawMessage `json:"dc_overrides,omitempty"`
	Server      json.RawMessage `json:"server,omitempty"`
}

// ReloadQuery configures the optional inline reload PatchConfig triggers via
// its query string (reload=instant|drain&timeout_secs=&failure_policy=,
// config_edit.rs / maestro/reload.rs ReloadRequest::from_query). A zero
// value (Mode == "") sends no query at all: the patch still writes and
// returns revision/changed/*_required as usual, but Telemt does not act on
// runtime_reload_required — the caller has to call Reload separately, or
// apply it on a later PatchConfig call.
type ReloadQuery struct {
	Mode          string
	TimeoutSecs   *uint64
	FailurePolicy string
}

// PatchConfigResult is the payload of PATCH /v1/config.
type PatchConfigResult struct {
	Revision               string          `json:"revision"`
	RestartRequired        bool            `json:"restart_required"` // legacy field; still sent by current Telemt
	RuntimeReloadRequired  bool            `json:"runtime_reload_required"`
	ProcessRestartRequired bool            `json:"process_restart_required"`
	DeferredProcessFields  []string        `json:"deferred_process_fields"`
	Changed                []string        `json:"changed"`
	Reload                 *ReloadAccepted `json:"reload,omitempty"`
}
