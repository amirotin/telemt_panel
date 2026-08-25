package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/host/hosttest"
	"github.com/amirotin/telemt_panel/internal/telemt"
	"github.com/amirotin/telemt_panel/internal/telemt/telemttest"
)

// newTelemttestConfigServer builds a logged-in Server against a
// telemttest.Server for scenario, mirroring telemt_handler_test.go's
// newTelemtInfoTestServer helper.
func newTelemttestConfigServer(t *testing.T, scenario telemttest.Scenario) (*Server, *http.Cookie, *telemttest.Server) {
	t.Helper()
	fake := telemttest.New(scenario)
	t.Cleanup(fake.Close)
	tc := telemt.New(fake.URL, "")
	srv, cookie := newTelemtInfoTestServer(t, tc)
	return srv, cookie, fake
}

func doRequest(t *testing.T, srv *Server, cookie *http.Cookie, method, path string, headers map[string]string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body != nil {
		r = httptest.NewRequest(method, path, bytes.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	// Same-origin per auth.CSRF's check — mirrors auth_handlers_test.go's
	// mutating() helper; every mutating method in this file needs it or
	// the CSRF middleware rejects the request before it ever reaches the
	// handler under test.
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	r.AddCookie(cookie)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)
	return w
}

// TestHandleGetTelemtConfig_Passthrough covers deliverable C's GET
// /api/telemt/config: {revision, sections} straight from telemt.GetConfig.
func TestHandleGetTelemtConfig_Passthrough(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})

	w := doRequest(t, srv, cookie, "GET", "/api/telemt/config", nil, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	var got telemtConfigView
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Revision == "" {
		t.Error("revision is empty")
	}
	if len(got.Sections.General) == 0 {
		t.Error("sections.general is empty, want telemttest's sample config")
	}
}

// TestHandleGetTelemtConfig_CapabilityUnavailable covers the proactive
// caps.config_api gate: an old-build Telemt reports 503
// capability_unavailable rather than a generic 404/501.
func TestHandleGetTelemtConfig_CapabilityUnavailable(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{OldBuild: true})

	w := doRequest(t, srv, cookie, "GET", "/api/telemt/config", nil, nil)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: %s", w.Code, w.Body)
	}
	var got struct{ Code string }
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Code != "capability_unavailable" {
		t.Errorf("code = %q, want capability_unavailable", got.Code)
	}
}

// TestHandlePatchTelemtConfig_RequiresIfMatch covers the required-header
// contract: no If-Match, no call to Telemt at all.
func TestHandlePatchTelemtConfig_RequiresIfMatch(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})

	body, _ := json.Marshal(telemtConfigPatchRequest{Sections: map[string]json.RawMessage{"general": json.RawMessage(`{"log_level":"debug"}`)}})
	w := doRequest(t, srv, cookie, "PATCH", "/api/telemt/config", nil, body)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", w.Code, w.Body)
	}
}

// TestHandlePatchTelemtConfig_Success covers the happy path end to end:
// GET for a revision, then PATCH with it as If-Match, asserting the
// SDK result passes through and an audit entry is recorded.
func TestHandlePatchTelemtConfig_Success(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})

	getW := doRequest(t, srv, cookie, "GET", "/api/telemt/config", nil, nil)
	var cfg telemtConfigView
	if err := json.Unmarshal(getW.Body.Bytes(), &cfg); err != nil {
		t.Fatalf("decode GET: %v", err)
	}

	body, _ := json.Marshal(telemtConfigPatchRequest{Sections: map[string]json.RawMessage{"general": json.RawMessage(`{"log_level":"debug"}`)}})
	w := doRequest(t, srv, cookie, "PATCH", "/api/telemt/config", map[string]string{"If-Match": cfg.Revision}, body)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	var result telemt.PatchConfigResult
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(result.Changed) != 1 || result.Changed[0] != "general" {
		t.Errorf("changed = %v, want [general]", result.Changed)
	}
	if result.Revision == cfg.Revision {
		t.Error("result.revision unchanged after a successful patch")
	}

	entries, err := srv.st.ListAudit(0)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	found := false
	for _, e := range entries {
		if e.Action == "config.patch" {
			found = true
		}
	}
	if !found {
		t.Error("no config.patch audit entry recorded")
	}
}

// TestHandlePatchTelemtConfig_RevisionConflict covers the stale-If-Match
// case: telemttest rejects a mismatched revision with 409 revision_conflict.
func TestHandlePatchTelemtConfig_RevisionConflict(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})

	body, _ := json.Marshal(telemtConfigPatchRequest{Sections: map[string]json.RawMessage{"general": json.RawMessage(`{"log_level":"debug"}`)}})
	w := doRequest(t, srv, cookie, "PATCH", "/api/telemt/config", map[string]string{"If-Match": "stale-revision"}, body)
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409: %s", w.Code, w.Body)
	}
	var got struct{ Code string }
	json.Unmarshal(w.Body.Bytes(), &got)
	if got.Code != "revision_conflict" {
		t.Errorf("code = %q, want revision_conflict", got.Code)
	}
}

// TestHandlePatchTelemtConfig_ReadOnly covers the read_only gate: 403 with
// Telemt's own code.
func TestHandlePatchTelemtConfig_ReadOnly(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{ReadOnly: true})

	body, _ := json.Marshal(telemtConfigPatchRequest{Sections: map[string]json.RawMessage{"general": json.RawMessage(`{"log_level":"debug"}`)}})
	w := doRequest(t, srv, cookie, "PATCH", "/api/telemt/config", map[string]string{"If-Match": "rev-0"}, body)
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403: %s", w.Code, w.Body)
	}
	var got struct{ Code string }
	json.Unmarshal(w.Body.Bytes(), &got)
	if got.Code != "read_only" {
		t.Errorf("code = %q, want read_only", got.Code)
	}
}

// TestHandlePatchTelemtConfig_EmptySectionsRejected covers request
// validation: an empty sections map never reaches Telemt.
func TestHandlePatchTelemtConfig_EmptySectionsRejected(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})

	body, _ := json.Marshal(telemtConfigPatchRequest{})
	w := doRequest(t, srv, cookie, "PATCH", "/api/telemt/config", map[string]string{"If-Match": "rev-0"}, body)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", w.Code, w.Body)
	}
}

// TestHandleTelemtReload_Accepted covers POST /api/telemt/reload's happy
// path and its audit entry.
func TestHandleTelemtReload_Accepted(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})

	w := doRequest(t, srv, cookie, "POST", "/api/telemt/reload", nil, []byte(`{}`))
	if w.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202: %s", w.Code, w.Body)
	}
	var accepted telemt.ReloadAccepted
	if err := json.Unmarshal(w.Body.Bytes(), &accepted); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if accepted.ReloadID == 0 {
		t.Error("reload_id is zero")
	}

	entries, _ := srv.st.ListAudit(0)
	found := false
	for _, e := range entries {
		if e.Action == "telemt.reload" {
			found = true
		}
	}
	if !found {
		t.Error("no telemt.reload audit entry recorded")
	}
}

// TestHandleTelemtReload_CapabilityAbsent covers the old-build case: the
// reload route 404s bare (no envelope) and must map to 501 capability_absent,
// not a generic error.
func TestHandleTelemtReload_CapabilityAbsent(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{OldBuild: true})

	w := doRequest(t, srv, cookie, "POST", "/api/telemt/reload", nil, nil)
	if w.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501: %s", w.Code, w.Body)
	}
	var got struct{ Code string }
	json.Unmarshal(w.Body.Bytes(), &got)
	if got.Code != "capability_absent" {
		t.Errorf("code = %q, want capability_absent", got.Code)
	}
}

// TestHandleTelemtReloadStatus_Success covers GET /api/telemt/reload/{id}
// against a reload id telemttest actually recorded.
func TestHandleTelemtReloadStatus_Success(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})

	postW := doRequest(t, srv, cookie, "POST", "/api/telemt/reload", nil, []byte(`{}`))
	var accepted telemt.ReloadAccepted
	json.Unmarshal(postW.Body.Bytes(), &accepted)

	w := doRequest(t, srv, cookie, "GET", "/api/telemt/reload/"+strconv.FormatUint(accepted.ReloadID, 10), nil, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	var status telemt.ReloadStatus
	if err := json.Unmarshal(w.Body.Bytes(), &status); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if status.ReloadID != accepted.ReloadID {
		t.Errorf("reload_id = %d, want %d", status.ReloadID, accepted.ReloadID)
	}
}

// TestHandleTelemtReloadStatus_UnknownIDIs404NotCapabilityAbsent covers the
// reload_not_found vs old-build-404 disambiguation this handler's doc
// comment describes: a genuinely unknown id on a build that HAS the reload
// API must be 404, never 501 capability_absent.
func TestHandleTelemtReloadStatus_UnknownIDIs404NotCapabilityAbsent(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})

	w := doRequest(t, srv, cookie, "GET", "/api/telemt/reload/999999", nil, nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404: %s", w.Code, w.Body)
	}
	var got struct{ Code string }
	json.Unmarshal(w.Body.Bytes(), &got)
	if got.Code != "reload_not_found" {
		t.Errorf("code = %q, want reload_not_found", got.Code)
	}
}

func TestHandleTelemtReloadStatus_BadID(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})

	w := doRequest(t, srv, cookie, "GET", "/api/telemt/reload/not-a-number", nil, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", w.Code, w.Body)
	}
}

// newRestartTestServer builds a logged-in Server with svcMgr/runner swapped
// for scriptable hosttest fakes, mirroring host_handler_test.go's
// newHostTestServer.
func newRestartTestServer(t *testing.T) (*Server, *http.Cookie, *hosttest.ServiceManager, *hosttest.Runner) {
	t.Helper()
	srv := newTestServer(t)
	svcMgr := &hosttest.ServiceManager{KindValue: host.KindSystemd, CapsValue: host.ServiceCaps{CanRestart: true}}
	runner := &hosttest.Runner{}
	srv.svcMgr = svcMgr
	srv.runner = runner
	srv.telemtServiceName = "telemt"

	h := srv.Handler()
	_, cookie := login(t, h, "admin", testPassword)
	if cookie == nil {
		t.Fatal("expected a successful login")
	}
	return srv, cookie, svcMgr, runner
}

// TestHandleTelemtRestart_Accepted covers the happy path: the runner is
// invoked with restart-service/telemt, and an audit entry is recorded.
func TestHandleTelemtRestart_Accepted(t *testing.T) {
	srv, cookie, _, runner := newRestartTestServer(t)

	w := doRequest(t, srv, cookie, "POST", "/api/telemt/restart", nil, nil)
	if w.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202: %s", w.Code, w.Body)
	}
	calls := runner.CallsSnapshot()
	if len(calls) != 1 || calls[0].Kind != host.OpRestartService || calls[0].Args[host.ArgService] != "telemt" {
		t.Errorf("runner calls = %+v, want one restart-service/telemt", calls)
	}

	entries, _ := srv.st.ListAudit(0)
	found := false
	for _, e := range entries {
		if e.Action == "telemt.restart" {
			found = true
		}
	}
	if !found {
		t.Error("no telemt.restart audit entry recorded")
	}
}

// TestHandleTelemtRestart_ManualRestartRequired covers the caps-gated 503:
// when the host can't restart automatically, the handler never even calls
// the Runner and instead reports the manual command hint.
func TestHandleTelemtRestart_ManualRestartRequired(t *testing.T) {
	srv, cookie, svcMgr, runner := newRestartTestServer(t)
	svcMgr.CapsValue = host.ServiceCaps{CanRestart: false, ManualRestartHint: "/etc/init.d/telemt restart"}

	w := doRequest(t, srv, cookie, "POST", "/api/telemt/restart", nil, nil)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: %s", w.Code, w.Body)
	}
	var got struct {
		Code    string
		Message string
	}
	json.Unmarshal(w.Body.Bytes(), &got)
	if got.Code != "manual_restart_required" {
		t.Errorf("code = %q, want manual_restart_required", got.Code)
	}
	if !bytes.Contains([]byte(got.Message), []byte("/etc/init.d/telemt restart")) {
		t.Errorf("message = %q, want it to contain the manual restart hint", got.Message)
	}
	if len(runner.CallsSnapshot()) != 0 {
		t.Error("runner was called despite CanRestart=false")
	}
}
