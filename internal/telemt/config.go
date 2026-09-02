package telemt

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
)

// GetConfig calls GET /v1/config, returning the editable config sections
// plus the response envelope's revision — callers chain that revision into
// a later PatchConfig's If-Match (07-telemt-sdk.md §SDK-5).
func (c *Client) GetConfig(ctx context.Context) (ConfigSections, string, error) {
	return getRevision[ConfigSections](ctx, c, "/v1/config")
}

// PatchConfig calls PATCH /v1/config. patch is a caller-built JSON Merge
// Patch object over the editable sections (general/timeouts/censorship/
// upstreams/dc_overrides/web/server.listeners) — deep-merged for tables,
// wholesale-replaced for arrays and scalars; unlike PatchUser, a nested
// JSON null inside a config patch is silently dropped by Telemt rather than
// removing a key (config_edit.rs json_to_toml), so there is no tri-state
// concern here. revision, when non-empty, is sent as If-Match; a mismatch
// surfaces as a revision_conflict *APIError. reload, when its Mode is set,
// asks Telemt to apply the write via an inline reload (see ReloadQuery).
func (c *Client) PatchConfig(ctx context.Context, patch map[string]any, revision string, reload ReloadQuery) (PatchConfigResult, int, string, error) {
	path := "/v1/config"
	if reload.Mode != "" {
		q := url.Values{}
		q.Set("reload", reload.Mode)
		if reload.TimeoutSecs != nil {
			q.Set("timeout_secs", strconv.FormatUint(*reload.TimeoutSecs, 10))
		}
		if reload.FailurePolicy != "" {
			q.Set("failure_policy", reload.FailurePolicy)
		}
		path += "?" + q.Encode()
	}
	return mutateRevisionStatus[PatchConfigResult](ctx, c, http.MethodPatch, path, patch, revision)
}
