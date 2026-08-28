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
	want := []string{"full", "old-build", "edge-off", "read-only"}
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
