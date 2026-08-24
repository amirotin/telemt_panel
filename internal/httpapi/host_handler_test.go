package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/host/hosttest"
)

// newHostTestServer builds a logged-in Server (via newTestServer) with its
// real host.ServiceManager/host.LogSource swapped for scriptable
// hosttest fakes — tests are in package httpapi, so they can set these
// unexported fields directly, the same way sse_test.go reaches srv.hub.
func newHostTestServer(t *testing.T) (*Server, *http.Cookie, *hosttest.ServiceManager, *hosttest.LogSource) {
	t.Helper()
	srv := newTestServer(t)
	svcMgr := &hosttest.ServiceManager{KindValue: host.KindSystemd}
	logSrc := &hosttest.LogSource{KindValue: host.LogKindJournald}
	srv.svcMgr = svcMgr
	srv.logSrc = logSrc

	h := srv.Handler()
	_, cookie := login(t, h, "admin", testPassword)
	if cookie == nil {
		t.Fatal("expected a successful login")
	}
	return srv, cookie, svcMgr, logSrc
}

func TestHandleHost_AllCapsTrue(t *testing.T) {
	srv, cookie, svcMgr, logSrc := newHostTestServer(t)
	svcMgr.CapsValue = host.ServiceCaps{CanRestart: true, CanStatus: true}
	logSrc.CapsValue = host.LogCaps{CanTail: true, CanStream: true}
	// Set explicitly rather than relying on the test process's euid — a
	// CI container running as root would otherwise make this test's
	// privileges_mode/self_update expectations depend on ambient
	// environment rather than the scripted ServiceCaps/LogCaps above.
	srv.privilegesMode = host.PrivilegesModeDirect

	r := httptest.NewRequest("GET", "/api/host", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	var got hostInfo
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.ServiceManager != host.KindSystemd || got.LogSource != host.LogKindJournald {
		t.Errorf("kinds = %q/%q, want systemd/journald", got.ServiceManager, got.LogSource)
	}
	if got.PrivilegesMode != host.PrivilegesModeDirect {
		t.Errorf("PrivilegesMode = %q, want direct", got.PrivilegesMode)
	}
	if !got.Caps.RestartTelemt || !got.Caps.RestartPanel || !got.Caps.LogTail || !got.Caps.LogStream {
		t.Errorf("caps = %+v, want restart/log caps all true", got.Caps)
	}
	if !got.Caps.SelfUpdate {
		t.Error("SelfUpdate = false, want true (privileges_mode is direct, not degraded)")
	}
	if len(got.ManualCommands) != 0 {
		t.Errorf("manual_commands = %v, want none (every cap is true)", got.ManualCommands)
	}
}

func TestHandleHost_AllCapsFalse_ManualCommandsCoverEveryGap(t *testing.T) {
	srv, cookie, svcMgr, logSrc := newHostTestServer(t)
	svcMgr.CapsValue = host.ServiceCaps{CanRestart: false, CanStatus: false, ManualRestartHint: "restart it yourself"}
	logSrc.CapsValue = host.LogCaps{CanTail: false, CanStream: false}
	srv.privilegesMode = host.PrivilegesModeDegraded

	r := httptest.NewRequest("GET", "/api/host", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	var got hostInfo
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Caps.RestartTelemt || got.Caps.RestartPanel || got.Caps.LogTail || got.Caps.LogStream || got.Caps.SelfUpdate {
		t.Errorf("caps = %+v, want all false", got.Caps)
	}
	for _, key := range []string{"restart_telemt", "restart_panel", "log_tail", "log_stream", "self_update"} {
		if hint, ok := got.ManualCommands[key]; !ok || hint == "" {
			t.Errorf("manual_commands[%q] = %q, ok=%v, want a non-empty hint", key, hint, ok)
		}
	}
	if got.ManualCommands["restart_telemt"] != "restart it yourself" {
		t.Errorf("restart_telemt hint = %q, want the ServiceManager's ManualRestartHint", got.ManualCommands["restart_telemt"])
	}
}

func TestHandleHost_RequiresSession(t *testing.T) {
	srv, _, _, _ := newHostTestServer(t)

	r := httptest.NewRequest("GET", "/api/host", nil)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestResolveLogicalService(t *testing.T) {
	cfg := config.HostConfig{
		TelemtService:   "telemt",
		PanelService:    "telemt-panel",
		TelemtContainer: "telemt-ctr",
		PanelContainer:  "panel-ctr",
	}

	tests := []struct {
		logical  string
		kind     string
		wantName string
		wantOK   bool
	}{
		{logical: "telemt", kind: host.KindSystemd, wantName: "telemt", wantOK: true},
		{logical: "telemt", kind: host.KindDocker, wantName: "telemt-ctr", wantOK: true},
		{logical: "panel", kind: host.KindSystemd, wantName: "telemt-panel", wantOK: true},
		{logical: "panel", kind: host.KindDocker, wantName: "panel-ctr", wantOK: true},
		{logical: "bogus", kind: host.KindSystemd, wantName: "", wantOK: false},
		{logical: "", kind: host.KindSystemd, wantName: "", wantOK: false},
	}
	for _, tc := range tests {
		t.Run(tc.logical+"/"+tc.kind, func(t *testing.T) {
			name, ok := resolveLogicalService(tc.logical, tc.kind, cfg)
			if name != tc.wantName || ok != tc.wantOK {
				t.Errorf("resolveLogicalService(%q, %q) = (%q, %v), want (%q, %v)", tc.logical, tc.kind, name, ok, tc.wantName, tc.wantOK)
			}
		})
	}
}
