package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
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
	srv.cfg.Host.TelemtService = "telemt"
	srv.cfg.Host.PanelService = "telemt-panel"
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
	if got.OS != runtime.GOOS || got.Arch != runtime.GOARCH {
		t.Errorf("platform = %q/%q, want %q/%q", got.OS, got.Arch, runtime.GOOS, runtime.GOARCH)
	}
	if !got.Caps.RestartTelemt || !got.Caps.RestartPanel || !got.Caps.LogTail || !got.Caps.LogStream {
		t.Errorf("caps = %+v, want restart/log caps all true", got.Caps)
	}
	if !got.Caps.SelfUpdate {
		t.Error("SelfUpdate = false, want true (privileges_mode is direct, not manual)")
	}
	if len(got.ManualCommands) != 0 {
		t.Errorf("manual_commands = %v, want none (every cap is true)", got.ManualCommands)
	}
}

func TestHandleHost_AllCapsFalse_ManualCommandsCoverEveryGap(t *testing.T) {
	srv, cookie, svcMgr, logSrc := newHostTestServer(t)
	svcMgr.CapsValue = host.ServiceCaps{CanRestart: false, CanStatus: false, ManualRestartHint: "restart it yourself"}
	logSrc.CapsValue = host.LogCaps{CanTail: false, CanStream: false}
	srv.privilegesMode = host.PrivilegesModeManual

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

func TestHandleHost_DegradedRunnerDisablesRestartEvenWhenManagerSupportsIt(t *testing.T) {
	srv, cookie, svcMgr, logSrc := newHostTestServer(t)
	svcMgr.CapsValue = host.ServiceCaps{CanRestart: true, CanStatus: true}
	logSrc.CapsValue = host.LogCaps{CanTail: true, CanStream: true}
	srv.privilegesMode = host.PrivilegesModeManual

	r := httptest.NewRequest("GET", "/api/host", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)

	var got hostInfo
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Caps.RestartTelemt || got.Caps.RestartPanel || got.Caps.SelfUpdate {
		t.Fatalf("privileged caps = %+v, want false in manual mode", got.Caps)
	}
	if !got.Caps.LogTail || !got.Caps.LogStream {
		t.Fatalf("log caps = %+v, want independent log source to remain available", got.Caps)
	}
	wantManual := map[string]string{
		"restart_telemt": "systemctl restart telemt",
		"restart_panel":  "systemctl restart telemt-panel",
		"self_update":    selfUpdateHint,
	}
	for key, want := range wantManual {
		if got.ManualCommands[key] != want {
			t.Errorf("manual_commands[%q] = %q, want %q", key, got.ManualCommands[key], want)
		}
	}
}

func TestManualRestartCommand(t *testing.T) {
	tests := []struct {
		kind    string
		service string
		want    string
	}{
		{kind: host.KindSystemd, service: "telemt", want: "systemctl restart telemt"},
		{kind: host.KindOpenRC, service: "telemt", want: "rc-service telemt restart"},
		{kind: host.KindProcd, service: "telemt", want: "/etc/init.d/telemt restart"},
		{kind: host.KindSysvinit, service: "telemt", want: "/etc/init.d/telemt restart"},
		{kind: host.KindDocker, service: "telemt-ctr", want: "docker restart telemt-ctr"},
		{kind: host.KindSystemd, service: "name with spaces", want: "systemctl restart 'name with spaces'"},
		{kind: host.KindSystemd, service: "bad'name", want: "systemctl restart 'bad'\"'\"'name'"},
		{kind: host.KindNone, service: "", want: "restart the service manually as an administrator"},
	}
	for _, tc := range tests {
		t.Run(tc.kind+"/"+tc.service, func(t *testing.T) {
			if got := manualRestartCommand(tc.kind, tc.service); got != tc.want {
				t.Errorf("manualRestartCommand(%q, %q) = %q, want %q", tc.kind, tc.service, got, tc.want)
			}
		})
	}
}

func TestParseOSRelease(t *testing.T) {
	tests := []struct {
		name string
		data string
		want string
	}{
		{name: "pretty name", data: "NAME=Debian\nPRETTY_NAME=\"Debian GNU/Linux 12 (bookworm)\"\n", want: "Debian GNU/Linux 12 (bookworm)"},
		{name: "openwrt", data: "DISTRIB_ID='OpenWrt'\nDISTRIB_DESCRIPTION='OpenWrt 24.10.0'\n", want: "OpenWrt 24.10.0"},
		{name: "name fallback", data: "NAME=Alpine Linux\n", want: "Alpine Linux"},
		{name: "comments and malformed", data: "# generated\nBROKEN\n", want: ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseOSRelease([]byte(tc.data)); got != tc.want {
				t.Errorf("parseOSRelease() = %q, want %q", got, tc.want)
			}
		})
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
