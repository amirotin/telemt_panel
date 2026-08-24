package telemt

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"
)

// capabilityCacheTTL is how long a probed Caps snapshot is reused before
// Capabilities re-probes Telemt (07-telemt-sdk.md §SDK-3: "кешируется").
const capabilityCacheTTL = 5 * time.Minute

// Caps mirrors api/openapi.yaml TelemtInfo.capabilities: the feature flags
// 07-telemt-sdk.md §SDK-3 defines, letting the panel show "unavailable on
// this Telemt build" instead of a dead control or a failed request.
type Caps struct {
	Quota             bool `json:"quota"`
	RuntimeEdge       bool `json:"runtime_edge"`
	ReloadAPI         bool `json:"reload_api"`
	ConfigAPI         bool `json:"config_api"`
	UserEnableDisable bool `json:"user_enable_disable"`
	RotateSecret      bool `json:"rotate_secret"`
}

// runtimeEdgeGate is the minimal shape of GET /v1/runtime/connections/summary
// needed to detect the runtime_edge capability: the gate wrapper's `enabled`
// field. The wrapper's `data` payload isn't needed for capability detection.
type runtimeEdgeGate struct {
	Enabled bool `json:"enabled"`
}

// Capabilities probes Telemt for the flags 07-telemt-sdk.md §SDK-3 defines
// and returns the result, caching it for capabilityCacheTTL (c.now is the
// injectable clock). A probe failure degrades that one flag to false and is
// logged rather than failing the whole call — a hiccup on one capability
// check must not make GET /api/telemt/info itself unusable. user_enable_disable
// and rotate_secret are never probed (a probe would have to call a mutating
// route, which is unsafe): both default true and flip to false lazily, the
// first time SetEnabled/RotateSecret sees a real 404/405 — see isRouteAbsent
// — independently of the cache below, so a flip is visible immediately
// rather than waiting out capabilityCacheTTL.
func (c *Client) Capabilities(ctx context.Context) (Caps, error) {
	if err := ctx.Err(); err != nil {
		return Caps{}, err
	}

	caps, cached := c.cachedCaps()
	if !cached {
		caps = c.probeCapsSingleFlight(ctx)
	}

	caps.UserEnableDisable = !c.userEnableDisableAbsent.Load()
	caps.RotateSecret = !c.rotateSecretAbsent.Load()
	return caps, nil
}

// probeCapsSingleFlight ensures only one goroutine actually probes Telemt
// per stale cache window. cachedCaps releases capsMu before a probe runs, so
// without this, N concurrent cold-cache callers would each fire a full
// 4-probe round (a thundering herd) — c.probeMu serializes entry, and the
// cachedCaps re-check under it (double-checked locking) lets every goroutine
// but the first skip straight to the winner's freshly stored result instead
// of probing again.
func (c *Client) probeCapsSingleFlight(ctx context.Context) Caps {
	c.probeMu.Lock()
	defer c.probeMu.Unlock()

	if caps, cached := c.cachedCaps(); cached {
		return caps
	}
	caps := c.probeCaps(ctx)
	c.storeCaps(caps)
	return caps
}

func (c *Client) cachedCaps() (Caps, bool) {
	c.capsMu.Lock()
	defer c.capsMu.Unlock()
	if c.capsValid && c.now().Before(c.capsAt.Add(capabilityCacheTTL)) {
		return c.caps, true
	}
	return Caps{}, false
}

func (c *Client) storeCaps(caps Caps) {
	c.capsMu.Lock()
	defer c.capsMu.Unlock()
	c.caps = caps
	c.capsAt = c.now()
	c.capsValid = true
}

// probeCaps runs every probed capability check against Telemt. The
// user_enable_disable/rotate_secret fields of the result are meaningless
// zero values — Capabilities overwrites them from the lazy atomic flags
// after calling this.
func (c *Client) probeCaps(ctx context.Context) Caps {
	var caps Caps

	_, hasQuota, err := c.QuotaList(ctx)
	if err != nil {
		slog.Warn("telemt: capability probe: quota", "err", err)
	} else {
		caps.Quota = hasQuota
	}

	caps.RuntimeEdge = c.probeRuntimeEdge(ctx)
	caps.ReloadAPI = c.probeReloadAPI(ctx)
	caps.ConfigAPI = c.probeConfigAPI(ctx)
	return caps
}

// probeRuntimeEdge detects the runtime_edge capability from the gate
// wrapper's `enabled` field on GET /v1/runtime/connections/summary. This
// group is disabled by default on Telemt (runtime_edge_enabled defaults
// false), so any probe failure degrades to false rather than optimistically
// true — the opposite default from probeReloadAPI/probeConfigAPI, which are
// always-on groups where an ambiguous error shouldn't hide a real feature.
func (c *Client) probeRuntimeEdge(ctx context.Context) bool {
	data, _, err := c.call(ctx, http.MethodGet, "/v1/runtime/connections/summary", nil)
	if err != nil {
		slog.Warn("telemt: capability probe: runtime_edge", "err", err)
		return false
	}
	var gate runtimeEdgeGate
	if err := json.Unmarshal(data, &gate); err != nil {
		slog.Warn("telemt: capability probe: runtime_edge decode", "err", err)
		return false
	}
	return gate.Enabled
}

// probeReloadAPI judges the reload_api capability by GET /v1/system/reload/0
// — a route-exists probe, not a real reload id lookup. A 404 is ambiguous
// by status code alone: a live route answering "no such reload id" also
// responds 404, wrapped in the JSON error envelope with a real code (e.g.
// "not_found"). call's own envelope handling already distinguishes the two
// shapes (client.go): a bare 404 with no envelope becomes apiErr.Code ==
// "http_error" (the route itself isn't registered — false), while a
// well-formed envelope 404 keeps its real code (the route exists — true).
// Any other error is treated as the route existing (true), logged rather
// than trusted blindly.
func (c *Client) probeReloadAPI(ctx context.Context) bool {
	_, _, err := c.call(ctx, http.MethodGet, "/v1/system/reload/0", nil)
	if err == nil {
		return true
	}
	var apiErr *APIError
	if errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound {
		return apiErr.Code != "http_error"
	}
	slog.Warn("telemt: capability probe: reload_api", "err", err)
	return true
}

// probeConfigAPI judges the config_api capability by GET /v1/config: 200 is
// true, 404/405 (route absent — older Telemt builds are file-mode only) is
// false, any other error is treated as true and logged.
func (c *Client) probeConfigAPI(ctx context.Context) bool {
	_, _, err := c.call(ctx, http.MethodGet, "/v1/config", nil)
	if err == nil {
		return true
	}
	var apiErr *APIError
	if errors.As(err, &apiErr) && (apiErr.Status == http.StatusNotFound || apiErr.Status == http.StatusMethodNotAllowed) {
		return false
	}
	slog.Warn("telemt: capability probe: config_api", "err", err)
	return true
}
