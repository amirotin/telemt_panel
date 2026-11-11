package telemt

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
)

// RuntimeBaseline identifies the active generation and published configuration epoch.
type RuntimeBaseline struct {
	ActiveGeneration uint64 `json:"active_generation"`
	ConfigEpoch      uint64 `json:"config_epoch"`
	RuntimeMatch     string `json:"runtime_match"`
}

// ConfigStateData retains the full state projection, including unknown future
// fields and redaction metadata. DesiredRevision may be null when source is unreadable.
type ConfigStateData struct {
	Scope                 string                     `json:"scope"`
	Sections              []string                   `json:"sections"`
	Runtime               RuntimeBaseline            `json:"runtime"`
	RuntimeSampleCurrent  bool                       `json:"runtime_sample_current"`
	DesiredRevision       *string                    `json:"desired_revision"`
	DesiredStatus         string                     `json:"desired_status"`
	DesiredError          *FieldIssue                `json:"desired_error"`
	Desired               json.RawMessage            `json:"desired"`
	Effective             json.RawMessage            `json:"effective"`
	ProjectionError       *FieldIssue                `json:"projection_error"`
	Comparison            json.RawMessage            `json:"comparison"`
	Watcher               json.RawMessage            `json:"watcher"`
	WatcherMatchesDesired *bool                      `json:"watcher_matches_desired"`
	Reload                json.RawMessage            `json:"reload"`
	ReloadObservation     string                     `json:"reload_observation"`
	ReloadMatchesDesired  *bool                      `json:"reload_matches_desired"`
	SubsystemConvergence  string                     `json:"subsystem_convergence"`
	Extra                 map[string]json.RawMessage `json:"-"`
}

// UnmarshalJSON preserves state extensions without passing them through float64.
func (s *ConfigStateData) UnmarshalJSON(data []byte) error {
	type plain ConfigStateData
	var value plain
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	*s = ConfigStateData(value)
	s.Extra = fields
	return nil
}

// MarshalJSON returns the source state fields, including future extensions.
func (s ConfigStateData) MarshalJSON() ([]byte, error) {
	type plain ConfigStateData
	data, err := json.Marshal(plain(s))
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err = json.Unmarshal(data, &fields); err != nil {
		return nil, err
	}
	for key, value := range s.Extra {
		if _, exists := fields[key]; !exists {
			fields[key] = value
		}
	}
	return json.Marshal(fields)
}

// ConfigApplyImpact separates watcher changes, generation reloads and process restarts.
type ConfigApplyImpact struct {
	WatcherPaths           []string `json:"watcher_paths"`
	GenerationPaths        []string `json:"generation_paths"`
	ProcessRestartPaths    []string `json:"process_restart_paths"`
	RestartRequired        bool     `json:"restart_required"`
	RuntimeReloadRequired  bool     `json:"runtime_reload_required"`
	ProcessRestartRequired bool     `json:"process_restart_required"`
	DeferredProcessFields  []string `json:"deferred_process_fields"`
}

// ConfigValidationData is the non-mutating preparation result; normalizations
// retain source values and any additional metadata as raw JSON.
type ConfigValidationData struct {
	Valid                bool              `json:"valid"`
	BaseRevision         string            `json:"base_revision"`
	CandidateRevision    string            `json:"candidate_revision"`
	Runtime              RuntimeBaseline   `json:"runtime"`
	ChangedPaths         []string          `json:"changed_paths"`
	NormalizationEffects []json.RawMessage `json:"normalization_effects"`
	Apply                ConfigApplyImpact `json:"apply"`
	SourceOwnership      string            `json:"source_ownership"`
	TouchedSections      []string          `json:"touched_sections"`
	Reload               *ReloadRequest    `json:"reload"`
	Warnings             []FieldIssue      `json:"warnings"`
}

// ConfigState reads desired/effective projections; the envelope revision may be null.
func (c *Client) ConfigState(ctx context.Context) (ConfigStateData, *string, error) {
	data, revision, err := getRevision[ConfigStateData](ctx, c, "/v1/config/state")
	if err != nil {
		return data, nil, err
	}
	if revision == "" {
		return data, nil, nil
	}
	return data, &revision, nil
}

// ValidateConfig prepares a candidate without writing files or publishing runtime.
// It uses the same DNS/static preparation timeout as PatchConfig.
func (c *Client) ValidateConfig(ctx context.Context, patch map[string]any, revision, runtimeMatch string, reload ReloadQuery) (ConfigValidationData, string, error) {
	value, _, next, err := configCall[ConfigValidationData](ctx, c, http.MethodPost, configQueryPath("/v1/config/validate", reload), patch, revision, runtimeMatch)
	return value, next, err
}

// PatchConfigRuntime is PatchConfig with an optional runtime publication fence.
func (c *Client) PatchConfigRuntime(ctx context.Context, patch map[string]any, revision, runtimeMatch string, reload ReloadQuery) (PatchConfigResult, int, string, error) {
	return configCall[PatchConfigResult](ctx, c, http.MethodPatch, configQueryPath("/v1/config", reload), patch, revision, runtimeMatch)
}

func configQueryPath(path string, reload ReloadQuery) string {
	if reload.Mode == "" {
		return path
	}
	q := url.Values{}
	q.Set("reload", reload.Mode)
	if reload.TimeoutSecs != nil {
		q.Set("timeout_secs", strconv.FormatUint(*reload.TimeoutSecs, 10))
	}
	if reload.FailurePolicy != "" {
		q.Set("failure_policy", reload.FailurePolicy)
	}
	return path + "?" + q.Encode()
}

func configCall[T any](ctx context.Context, c *Client, method, path string, body any, revision, runtimeMatch string) (T, int, string, error) {
	var value T
	data, status, next, err := c.callStatusRuntime(ctx, method, path, body, revision, runtimeMatch)
	if err != nil {
		return value, 0, "", err
	}
	if err = json.Unmarshal(data, &value); err != nil {
		return value, 0, "", fmt.Errorf("telemt: decode %s: %w: %w", path, ErrInvalidResponse, err)
	}
	if err := validateDecodedResponse(data, &value, next, true); err != nil {
		return value, 0, "", err
	}
	normalizeSlices(&value)
	return value, status, next, nil
}
