package telemt

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

func TestGetConfigIntegerRoundTrip(t *testing.T) {
	// A json.Unmarshal into float64 would corrupt a large integer; RawMessage
	// must preserve the exact byte sequence Telemt sent.
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/config" {
			t.Errorf("path = %s", r.URL.Path)
		}
		w.Write([]byte(`{"ok":true,"data":{"general":{"upstream_connect_budget_ms":9007199254740993,"log_level":"info"}},"revision":"cfg-1"}`))
	})

	sections, revision, err := c.GetConfig(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if revision != "cfg-1" {
		t.Errorf("revision = %q", revision)
	}
	if sections.Timeouts != nil {
		t.Errorf("absent section must stay nil, got %s", sections.Timeouts)
	}
	var general map[string]json.RawMessage
	if err := json.Unmarshal(sections.General, &general); err != nil {
		t.Fatal(err)
	}
	if string(general["upstream_connect_budget_ms"]) != "9007199254740993" {
		t.Errorf("integer round-trip broken: got %s", general["upstream_connect_budget_ms"])
	}
}

func TestPatchConfigWithReloadQuery(t *testing.T) {
	var gotQuery string
	var gotIfMatch string
	var gotBody []byte
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch || r.URL.Path != "/v1/config" {
			t.Errorf("method/path = %s %s", r.Method, r.URL.Path)
		}
		gotQuery = r.URL.RawQuery
		gotIfMatch = r.Header.Get("If-Match")
		buf, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read request body: %v", err)
		}
		gotBody = buf
		w.WriteHeader(http.StatusAccepted)
		w.Write([]byte(`{"ok":true,"data":{"revision":"cfg-2","restart_required":false,
			"runtime_reload_required":true,"process_restart_required":false,
			"deferred_process_fields":[],"changed":["general"],
			"reload":{"reload_id":1,"target_generation":2,"config_revision":"cfg-2","state":"accepted","mode":"instant","failure_policy":"keep_new"}},
			"revision":"cfg-2"}`))
	})

	timeout := uint64(20)
	patch := map[string]any{"general": map[string]any{"log_level": "debug"}}
	result, revision, err := c.PatchConfig(context.Background(), patch, "cfg-1",
		ReloadQuery{Mode: ReloadModeDrain, TimeoutSecs: &timeout, FailurePolicy: ReloadFailurePolicyRollback})
	if err != nil {
		t.Fatal(err)
	}
	if revision != "cfg-2" || result.Revision != "cfg-2" {
		t.Errorf("revision = %q, result.Revision = %q", revision, result.Revision)
	}
	if !result.RuntimeReloadRequired || result.Reload == nil || result.Reload.ReloadID != 1 {
		t.Errorf("result = %+v", result)
	}
	if gotIfMatch != "cfg-1" {
		t.Errorf("If-Match = %q, want cfg-1", gotIfMatch)
	}
	wantQuery := "failure_policy=rollback&reload=drain&timeout_secs=20"
	if gotQuery != wantQuery {
		t.Errorf("query = %q, want %q", gotQuery, wantQuery)
	}
	var sent map[string]any
	if err := json.Unmarshal(gotBody, &sent); err != nil {
		t.Fatalf("decode sent body: %v", err)
	}
	if _, ok := sent["general"]; !ok {
		t.Errorf("sent body missing general section: %s", gotBody)
	}
}

func TestPatchConfigWithoutReloadOmitsQuery(t *testing.T) {
	var gotQuery string
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		w.Write([]byte(`{"ok":true,"data":{"revision":"cfg-2","restart_required":false,
			"runtime_reload_required":false,"process_restart_required":false,
			"deferred_process_fields":[],"changed":["general"]},"revision":"cfg-2"}`))
	})

	_, _, err := c.PatchConfig(context.Background(), map[string]any{"general": map[string]any{}}, "", ReloadQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if gotQuery != "" {
		t.Errorf("query = %q, want empty (no reload requested)", gotQuery)
	}
}

func TestPatchConfigRevisionConflict(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		w.Write([]byte(`{"ok":false,"error":{"code":"revision_conflict","message":"config changed"},"request_id":1}`))
	})

	_, _, err := c.PatchConfig(context.Background(), map[string]any{"general": map[string]any{}}, "stale", ReloadQuery{})
	if err == nil {
		t.Fatal("expected an error")
	}
}
