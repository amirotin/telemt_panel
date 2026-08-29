package telemttest

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

func newTestServer(t *testing.T, scenario Scenario) (*Server, *telemt.Client) {
	t.Helper()
	srv := New(scenario)
	t.Cleanup(srv.Close)
	return srv, telemt.New(srv.URL, "")
}

// TestDefaultScenarioCoversEveryNewEndpoint exercises every method Task 1
// added, end to end against the fake, to prove the fixtures decode cleanly
// through the SDK's own types.
func TestDefaultScenarioCoversEveryNewEndpoint(t *testing.T) {
	_, c := newTestServer(t, Scenario{})
	ctx := context.Background()

	if _, err := c.Ready(ctx); err != nil {
		t.Errorf("Ready: %v", err)
	}
	if _, _, err := c.Reload(ctx, telemt.ReloadRequest{}, ""); err != nil {
		t.Errorf("Reload: %v", err)
	}
	if _, err := c.ReloadStatus(ctx, 1); err != nil {
		t.Errorf("ReloadStatus: %v", err)
	}
	if _, err := c.ZeroAll(ctx); err != nil {
		t.Errorf("ZeroAll: %v", err)
	}
	if _, err := c.Upstreams(ctx); err != nil {
		t.Errorf("Upstreams: %v", err)
	}
	if _, err := c.DCs(ctx); err != nil {
		t.Errorf("DCs: %v", err)
	}
	if _, err := c.MeWriters(ctx); err != nil {
		t.Errorf("MeWriters: %v", err)
	}
	if _, err := c.MinimalAll(ctx); err != nil {
		t.Errorf("MinimalAll: %v", err)
	}
	if _, err := c.ActiveIPs(ctx); err != nil {
		t.Errorf("ActiveIPs: %v", err)
	}
	if _, err := c.Gates(ctx); err != nil {
		t.Errorf("Gates: %v", err)
	}
	if _, err := c.Initialization(ctx); err != nil {
		t.Errorf("Initialization: %v", err)
	}
	if _, err := c.MePoolState(ctx); err != nil {
		t.Errorf("MePoolState: %v", err)
	}
	if _, err := c.MeQuality(ctx); err != nil {
		t.Errorf("MeQuality: %v", err)
	}
	if _, err := c.UpstreamQuality(ctx); err != nil {
		t.Errorf("UpstreamQuality: %v", err)
	}
	if _, err := c.NatStun(ctx); err != nil {
		t.Errorf("NatStun: %v", err)
	}
	if _, err := c.MeSelfTest(ctx); err != nil {
		t.Errorf("MeSelfTest: %v", err)
	}
	if _, err := c.EffectiveLimits(ctx); err != nil {
		t.Errorf("EffectiveLimits: %v", err)
	}
	if _, err := c.Posture(ctx); err != nil {
		t.Errorf("Posture: %v", err)
	}
	if _, err := c.Whitelist(ctx); err != nil {
		t.Errorf("Whitelist: %v", err)
	}
	if _, _, err := c.GetConfig(ctx); err != nil {
		t.Errorf("GetConfig: %v", err)
	}
	if _, _, err := c.PatchConfig(ctx, map[string]any{"general": map[string]any{"log_level": "debug"}}, "", telemt.ReloadQuery{}); err != nil {
		t.Errorf("PatchConfig: %v", err)
	}

	// runtime_edge is off by default (Scenario zero value) — these must
	// still decode cleanly, just closed.
	edge, err := c.ConnectionsSummary(ctx)
	if err != nil {
		t.Errorf("ConnectionsSummary: %v", err)
	} else if edge.Enabled {
		t.Errorf("ConnectionsSummary should be closed by default, got %+v", edge)
	}
	if _, err := c.RecentEvents(ctx, 10); err != nil {
		t.Errorf("RecentEvents: %v", err)
	}
	if _, err := c.TLSFingerprints(ctx, 10); err != nil {
		t.Errorf("TLSFingerprints: %v", err)
	}
}

func TestRuntimeEdgeScenarioOpensTheGate(t *testing.T) {
	_, c := newTestServer(t, Scenario{RuntimeEdge: true})
	ctx := context.Background()

	got, err := c.ConnectionsSummary(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Enabled || got.Data == nil {
		t.Errorf("connections summary = %+v, want open with data", got)
	}

	events, err := c.RecentEvents(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if !events.Enabled || events.Data == nil {
		t.Errorf("recent events = %+v, want open with data", events)
	}

	fp, err := c.TLSFingerprints(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if !fp.Enabled || fp.Data == nil || len(fp.Data.ByFingerprint) == 0 {
		t.Errorf("tls fingerprints = %+v, want open with rows", fp)
	}
}

func TestMinimalRuntimeOffScenario(t *testing.T) {
	_, c := newTestServer(t, Scenario{MinimalRuntimeOff: true})
	ctx := context.Background()

	upstreams, err := c.Upstreams(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if upstreams.Enabled {
		t.Errorf("upstreams should be disabled: %+v", upstreams)
	}

	dcs, err := c.DCs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if dcs.MiddleProxyEnabled || dcs.DCs == nil {
		t.Errorf("dcs = %+v, want disabled with empty (not nil) array", dcs)
	}

	minimal, err := c.MinimalAll(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if minimal.Enabled || minimal.Data != nil {
		t.Errorf("minimal all = %+v, want closed gate", minimal)
	}

	// The /v1/runtime/* group is registered unconditionally and its builders
	// take no ApiConfig (telemt 3.5.5 src/api/runtime_min.rs), so
	// minimal_runtime_enabled cannot close any of it. A mock that closed
	// nat-stun here is what taught the panel to print an inert config flag
	// as NAT/STUN's "как включить" hint.
	nat, err := c.NatStun(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !nat.Enabled || nat.Data == nil {
		t.Errorf("nat stun = %+v, want open with data: no flag gates /v1/runtime/nat-stun", nat)
	}

	pool, err := c.MePoolState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !pool.Enabled || pool.Data == nil {
		t.Errorf("me pool state = %+v, want open with data", pool)
	}

	selftest, err := c.MeSelfTest(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !selftest.Enabled || selftest.Data == nil {
		t.Errorf("me selftest = %+v, want open with data", selftest)
	}

	quality, err := c.UpstreamQuality(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !quality.Enabled {
		t.Errorf("upstream quality = %+v, want open: no flag gates it either", quality)
	}
}

// TestMePoolDownScenario pins the OTHER gate: the ME pool being absent is
// what really closes the /v1/runtime/* ME payloads, and it says so with
// `source_unavailable` rather than `feature_disabled` — the two tokens are
// what the panel maps to two different "как включить" hints.
func TestMePoolDownScenario(t *testing.T) {
	_, c := newTestServer(t, Scenario{RuntimeEdge: true, MePoolDown: true})
	ctx := context.Background()

	nat, err := c.NatStun(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if nat.Enabled || nat.Data != nil || nat.Reason != "source_unavailable" {
		t.Errorf("nat stun = %+v, want closed with source_unavailable", nat)
	}

	pool, err := c.MePoolState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if pool.Enabled || pool.Reason != "source_unavailable" {
		t.Errorf("me pool state = %+v, want closed with source_unavailable", pool)
	}

	quality, err := c.MeQuality(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if quality.Enabled || quality.Reason != "source_unavailable" {
		t.Errorf("me quality = %+v, want closed with source_unavailable", quality)
	}

	selftest, err := c.MeSelfTest(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if selftest.Enabled || selftest.Reason != "source_unavailable" {
		t.Errorf("me selftest = %+v, want closed with source_unavailable", selftest)
	}

	// The /v1/stats/* minimal routes stay `enabled` at the wrapper level and
	// push the source state into their own reason — Telemt's own shape in
	// runtime_stats.rs::build_minimal_all_data.
	dcs, err := c.DCs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if dcs.MiddleProxyEnabled || dcs.Reason != "source_unavailable" {
		t.Errorf("dcs = %+v, want closed with source_unavailable", dcs)
	}

	writers, err := c.MeWriters(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if writers.MiddleProxyEnabled || writers.Reason != "source_unavailable" {
		t.Errorf("me writers = %+v, want closed with source_unavailable", writers)
	}

	minimal, err := c.MinimalAll(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !minimal.Enabled || minimal.Reason != "source_unavailable" || minimal.Data == nil {
		t.Fatalf("minimal all = %+v, want enabled with source_unavailable and nested payload", minimal)
	}
	if minimal.Data.DCs.Reason != "source_unavailable" {
		t.Errorf("minimal all dcs = %+v, want the source state pushed down", minimal.Data.DCs)
	}

	// runtime_edge is untouched by the ME pool.
	conns, err := c.ConnectionsSummary(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !conns.Enabled || conns.Data == nil {
		t.Errorf("connections summary = %+v, want open: the ME pool does not gate runtime_edge", conns)
	}
}

// TestUpstreamSourceDownScenario pins the third cause: a lost `try_read` on
// the upstream manager. /v1/stats/upstreams keeps `enabled` true and only
// changes its reason, and /v1/runtime/upstream-quality — which no flag gates
// — closes with the same token.
func TestUpstreamSourceDownScenario(t *testing.T) {
	_, c := newTestServer(t, Scenario{RuntimeEdge: true, UpstreamSourceDown: true})
	ctx := context.Background()

	upstreams, err := c.Upstreams(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !upstreams.Enabled || upstreams.Reason != "source_unavailable" || upstreams.Summary != nil {
		t.Errorf("upstreams = %+v, want enabled with source_unavailable and no summary", upstreams)
	}

	quality, err := c.UpstreamQuality(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if quality.Enabled || quality.Reason != "source_unavailable" {
		t.Errorf("upstream quality = %+v, want closed with source_unavailable", quality)
	}
	if quality.Policy.ConnectRetryAttempts == 0 {
		t.Errorf("upstream quality policy = %+v, want it filled even on a closed gate", quality.Policy)
	}
}

func TestOldBuildScenario404sQuotaReloadConfig(t *testing.T) {
	_, c := newTestServer(t, Scenario{OldBuild: true})
	ctx := context.Background()

	if _, ok, err := c.QuotaList(ctx); err != nil || ok {
		t.Errorf("QuotaList: err=%v ok=%v, want (nil, false, nil)", err, ok)
	}

	_, _, err := c.GetConfig(ctx)
	var apiErr *telemt.APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusNotFound {
		t.Fatalf("GetConfig err = %v, want a bare 404 *APIError", err)
	}

	_, _, err = c.Reload(ctx, telemt.ReloadRequest{}, "")
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusNotFound {
		t.Fatalf("Reload err = %v, want a bare 404 *APIError", err)
	}

	_, err = c.ReloadStatus(ctx, 1)
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusNotFound {
		t.Fatalf("ReloadStatus err = %v, want a bare 404 *APIError", err)
	}
}

func TestReadOnlyScenarioRejectsMutations(t *testing.T) {
	_, c := newTestServer(t, Scenario{ReadOnly: true})
	ctx := context.Background()

	assertReadOnly := func(t *testing.T, err error) {
		t.Helper()
		var apiErr *telemt.APIError
		if !errors.As(err, &apiErr) || apiErr.Code != "read_only" || apiErr.Status != http.StatusForbidden {
			t.Fatalf("err = %v, want a 403 read_only *APIError", err)
		}
	}

	_, _, err := c.CreateUser(ctx, telemt.CreateUserRequest{Username: "bob"})
	assertReadOnly(t, err)

	_, err = c.PatchUser(ctx, "alice", map[string]any{"enabled": false})
	assertReadOnly(t, err)

	err = c.DeleteUser(ctx, "alice")
	assertReadOnly(t, err)

	_, _, err = c.RotateSecret(ctx, "alice")
	assertReadOnly(t, err)

	_, err = c.SetEnabled(ctx, "alice", false)
	assertReadOnly(t, err)

	_, err = c.ResetQuota(ctx, "alice")
	assertReadOnly(t, err)

	_, _, err = c.PatchConfig(ctx, map[string]any{"general": map[string]any{}}, "", telemt.ReloadQuery{})
	assertReadOnly(t, err)

	_, _, err = c.Reload(ctx, telemt.ReloadRequest{}, "")
	assertReadOnly(t, err)
}

// TestBodyLimitBytesMapsToPayloadTooLarge covers the 64KB body-limit "known
// rake": a PATCH /v1/config body over the limit must decode to a clear,
// typed error rather than a generic transport failure.
func TestBodyLimitBytesMapsToPayloadTooLarge(t *testing.T) {
	_, c := newTestServer(t, Scenario{BodyLimitBytes: 16})
	ctx := context.Background()

	patch := map[string]any{"general": map[string]any{"log_level": "this string alone is well over sixteen bytes"}}
	_, _, err := c.PatchConfig(ctx, patch, "", telemt.ReloadQuery{})
	var apiErr *telemt.APIError
	if !errors.As(err, &apiErr) || apiErr.Code != "payload_too_large" || apiErr.Status != http.StatusRequestEntityTooLarge {
		t.Fatalf("err = %v, want a 413 payload_too_large *APIError", err)
	}
}

// TestPatchWebLimitsIsProcessDeferred covers the fake's one deferred-field
// rule: patching under `[web.limits]` succeeds but comes back reported as
// restart-required, which is what drives the panel's "требуется рестарт"
// banner and its field list.
func TestPatchWebLimitsIsProcessDeferred(t *testing.T) {
	_, c := newTestServer(t, Scenario{})
	ctx := context.Background()

	patch := map[string]any{"web": map[string]any{"limits": map[string]any{"max_sessions_global": 256}}}
	result, _, err := c.PatchConfig(ctx, patch, "", telemt.ReloadQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if !result.ProcessRestartRequired || len(result.DeferredProcessFields) != 1 || result.DeferredProcessFields[0] != "web.limits" {
		t.Errorf("result = %+v, want process_restart_required with deferred_process_fields [web.limits]", result)
	}

	// A patch that stays out of web.limits reloads in place.
	plain, _, err := c.PatchConfig(ctx, map[string]any{"general": map[string]any{"log_level": "debug"}}, "", telemt.ReloadQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if plain.ProcessRestartRequired || len(plain.DeferredProcessFields) != 0 {
		t.Errorf("result = %+v, want no deferred fields", plain)
	}
}

func TestPatchConfigRevisionConflictAgainstFake(t *testing.T) {
	_, c := newTestServer(t, Scenario{})
	ctx := context.Background()

	_, _, err := c.PatchConfig(ctx, map[string]any{"general": map[string]any{}}, "not-the-real-revision", telemt.ReloadQuery{})
	var apiErr *telemt.APIError
	if !errors.As(err, &apiErr) || apiErr.Code != "revision_conflict" {
		t.Fatalf("err = %v, want revision_conflict", err)
	}
}

func TestReloadStatusUnknownIDIsWellFormedNotFound(t *testing.T) {
	_, c := newTestServer(t, Scenario{})
	ctx := context.Background()

	_, err := c.ReloadStatus(ctx, 999)
	var apiErr *telemt.APIError
	if !errors.As(err, &apiErr) || apiErr.Code != "reload_not_found" || apiErr.Status != http.StatusNotFound {
		t.Fatalf("err = %v, want a well-formed reload_not_found 404", err)
	}
}

func TestSetScenarioSwapsBehaviorMidTest(t *testing.T) {
	srv, c := newTestServer(t, Scenario{})
	ctx := context.Background()

	if _, err := c.Posture(ctx); err != nil {
		t.Fatal(err)
	}
	srv.SetScenario(Scenario{ReadOnly: true})
	_, _, err := c.PatchConfig(ctx, map[string]any{"general": map[string]any{}}, "", telemt.ReloadQuery{})
	var apiErr *telemt.APIError
	if !errors.As(err, &apiErr) || apiErr.Code != "read_only" {
		t.Fatalf("err = %v, want read_only after SetScenario", err)
	}
}
