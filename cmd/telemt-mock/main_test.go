package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/amirotin/telemt_panel/internal/telemt/telemttest"
)

// TestScenariosCoverTheDocumentedFlagValues locks the -scenario flag's
// usage string to the actual map keys, so the two can't drift apart.
func TestScenariosCoverTheDocumentedFlagValues(t *testing.T) {
	want := []string{
		"full", "old-build", "edge-off", "edge-gated",
		"me-pool-down", "upstream-source-down", "read-only", "web-off", "web-busy",
	}
	if len(scenarios) != len(want) {
		t.Fatalf("scenarios has %d entries, want %d: %v", len(scenarios), len(want), scenarios)
	}
	for _, name := range want {
		if _, ok := scenarios[name]; !ok {
			t.Errorf("scenarios is missing %q", name)
		}
	}
}

// TestScenarioFull covers the "full" scenario's distinguishing behavior:
// runtime_edge is on (unlike telemttest's own zero-value default).
func TestScenarioFull(t *testing.T) {
	fake := telemttest.New(scenarios["full"])
	defer fake.Close()

	w := httptest.NewRecorder()
	fake.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/v1/runtime/connections/summary", nil))
	var got struct {
		Data struct {
			Enabled bool `json:"enabled"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !got.Data.Enabled {
		t.Error("full scenario: connections/summary enabled = false, want true")
	}
}

// TestScenarioFullServesWebConfigSection pins the dev stack's config
// payload to the Telemt 3.5.3+ shape: `/v1/config` carries a `[web]`
// section (with the process-deferred `web.limits` subtable), so the panel's
// raw config editor is exercised against a section it has no typed
// knowledge of — the M4 T1b passthrough path.
func TestScenarioFullServesWebConfigSection(t *testing.T) {
	fake := telemttest.New(scenarios["full"])
	defer fake.Close()

	w := httptest.NewRecorder()
	fake.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/v1/config", nil))
	var got struct {
		Data struct {
			Web struct {
				Enabled bool            `json:"enabled"`
				Limits  json.RawMessage `json:"limits"`
			} `json:"web"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !got.Data.Web.Enabled || len(got.Data.Web.Limits) == 0 {
		t.Errorf("full scenario: /v1/config web = %+v, want enabled with a limits table", got.Data.Web)
	}
}

// TestScenarioEdgeOff covers the "edge-off" scenario: the stock-config
// default, runtime_edge closed.
func TestScenarioEdgeOff(t *testing.T) {
	fake := telemttest.New(scenarios["edge-off"])
	defer fake.Close()

	w := httptest.NewRecorder()
	fake.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/v1/runtime/connections/summary", nil))
	var got struct {
		Data struct {
			Enabled bool `json:"enabled"`
		} `json:"data"`
	}
	json.Unmarshal(w.Body.Bytes(), &got)
	if got.Data.Enabled {
		t.Error("edge-off scenario: connections/summary enabled = true, want false")
	}
}

// TestScenarioEdgeGated covers the "edge-gated" scenario: the OTHER wire
// shape a gate can take. runtime_edge is on, so the panel's capability
// probe passes and connections/events carry real data, while the minimal
// runtime group answers with a present-but-disabled Gated wrapper instead
// of a missing key — the branch details-builder/sources.ts resolves through
// gatedStatus rather than through the absent-wrapper rule.
func TestScenarioEdgeGated(t *testing.T) {
	fake := telemttest.New(scenarios["edge-gated"])
	defer fake.Close()

	var gate struct {
		Data struct {
			Enabled bool   `json:"enabled"`
			Reason  string `json:"reason"`
		} `json:"data"`
	}
	get := func(path string) {
		t.Helper()
		w := httptest.NewRecorder()
		fake.Handler().ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		gate.Data.Enabled, gate.Data.Reason = false, ""
		if err := json.Unmarshal(w.Body.Bytes(), &gate); err != nil {
			t.Fatalf("decode %s: %v", path, err)
		}
	}

	get("/v1/runtime/connections/summary")
	if !gate.Data.Enabled {
		t.Error("edge-gated: connections/summary enabled = false, want true (the capability probe must pass)")
	}
	// minimal_runtime_enabled gates the /v1/stats/* routes and nothing else:
	// the wrapper branch this scenario exists to produce lives there.
	get("/v1/stats/minimal/all")
	if gate.Data.Enabled || gate.Data.Reason != "feature_disabled" {
		t.Errorf("edge-gated: /v1/stats/minimal/all = %+v, want a disabled wrapper with feature_disabled", gate.Data)
	}
	// ...while /v1/runtime/* stays open: no ApiConfig reaches its builders
	// (telemt 3.5.5 src/api/runtime_min.rs), so no flag can close it.
	for _, path := range []string{"/v1/runtime/nat-stun", "/v1/runtime/me-pool-state"} {
		get(path)
		if !gate.Data.Enabled {
			t.Errorf("edge-gated: %s = %+v, want open — minimal_runtime_enabled does not gate it", path, gate.Data)
		}
	}
}

// TestScenarioMePoolDown covers the scenario that DOES close the ME-pool
// payloads, and with the other reason token: `source_unavailable`, which the
// panel must not answer with a config-flag hint.
func TestScenarioMePoolDown(t *testing.T) {
	fake := telemttest.New(scenarios["me-pool-down"])
	defer fake.Close()

	var gate struct {
		Data struct {
			Enabled bool   `json:"enabled"`
			Reason  string `json:"reason"`
		} `json:"data"`
	}
	get := func(path string) {
		t.Helper()
		w := httptest.NewRecorder()
		fake.Handler().ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		gate.Data.Enabled, gate.Data.Reason = false, ""
		if err := json.Unmarshal(w.Body.Bytes(), &gate); err != nil {
			t.Fatalf("decode %s: %v", path, err)
		}
	}

	for _, path := range []string{
		"/v1/runtime/nat-stun", "/v1/runtime/me-pool-state",
		"/v1/runtime/me-quality", "/v1/runtime/me-selftest",
	} {
		get(path)
		if gate.Data.Enabled || gate.Data.Reason != "source_unavailable" {
			t.Errorf("me-pool-down: %s = %+v, want closed with source_unavailable", path, gate.Data)
		}
	}

	get("/v1/runtime/connections/summary")
	if !gate.Data.Enabled {
		t.Error("me-pool-down: connections/summary enabled = false, want true (runtime_edge is unaffected)")
	}
}

// TestScenarioOldBuild covers the "old-build" scenario: the config API
// route 404s bare (no envelope), the shape a route-absent build produces.
func TestScenarioOldBuild(t *testing.T) {
	fake := telemttest.New(scenarios["old-build"])
	defer fake.Close()

	w := httptest.NewRecorder()
	fake.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/v1/config", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
	var envelope map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &envelope); err == nil {
		t.Errorf("old-build /v1/config decoded as JSON (%v), want a bare non-JSON 404 body", envelope)
	}
}

// TestScenarioReadOnly covers the "read-only" scenario: a mutation 403s
// with the read_only code.
func TestScenarioReadOnly(t *testing.T) {
	fake := telemttest.New(scenarios["read-only"])
	defer fake.Close()

	r := httptest.NewRequest("PATCH", "/v1/config", nil)
	w := httptest.NewRecorder()
	fake.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
	var got struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	json.Unmarshal(w.Body.Bytes(), &got)
	if got.Error.Code != "read_only" {
		t.Errorf("code = %q, want read_only", got.Error.Code)
	}
}

// TestScenarioWebOff covers the "web-off" scenario's distinguishing
// behavior: the WEB status route still answers 200 (that route never
// fails), reporting the closure in its own fields, while the data routes
// answer 503 web_runtime_unavailable.
func TestScenarioWebOff(t *testing.T) {
	fake := telemttest.New(scenarios["web-off"])
	defer fake.Close()

	w := httptest.NewRecorder()
	fake.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/v1/runtime/web/status", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("GET web/status = %d, want 200", w.Code)
	}
	var status struct {
		Data struct {
			Available bool   `json:"available"`
			Reason    string `json:"reason"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &status); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if status.Data.Available || status.Data.Reason != "no_web_listener" {
		t.Errorf("status = %+v, want available=false reason=no_web_listener", status.Data)
	}

	w = httptest.NewRecorder()
	fake.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/v1/runtime/web/sessions", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("GET web/sessions = %d, want 503", w.Code)
	}
}
