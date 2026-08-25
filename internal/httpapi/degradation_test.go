package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

// TestAPIOnlyDegradation is the executable form of the panel's binding
// owner invariant: the absence of file access, host privileges, an init
// system, or even a reachable Telemt must never prevent the panel from
// starting or break API-backed features. It boots the full httpapi.Server
// (via New, not a stripped-down test helper) in the worst-case environment
// this milestone can produce — unreachable Telemt, no init system, no log
// source, degraded privileges, no on-disk state mirror — and asserts every
// surface degrades cleanly instead of panicking or hanging.
//
// This test must stay green forever; do not delete or weaken it without an
// explicit owner ruling superseding the invariant it encodes.
func TestAPIOnlyDegradation(t *testing.T) {
	hash, err := auth.HashPassword(testPassword)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	cfg := &config.Config{
		// Unreachable Telemt: nothing listens on this port.
		Telemt: config.TelemtConfig{URL: "http://127.0.0.1:1", ConfigEditMode: "api"},
		Auth:   config.AuthConfig{Username: "admin", PasswordHash: hash},
		// Mirror path "": state stays in RAM only, no on-disk mirror.
		DataDir: "",
		Subpage: config.SubpageConfig{Enabled: true, Secret: "test-subpage-secret"},
		Host: config.HostConfig{
			ServiceManager: "none",
			TelemtService:  "telemt",
			PanelService:   "telemt-panel",
		},
		Privileges: config.PrivilegesConfig{Mode: "auto", AgentSocket: "/nonexistent/agent.sock"},
	}

	tc := telemt.New(cfg.Telemt.URL, cfg.Telemt.AuthHeader)
	st, err := store.NewMemory(cfg.DataDir)
	if err != nil {
		t.Fatalf("store.NewMemory: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	hb := hub.New(hub.Config{}, tc, st)
	t.Cleanup(hb.Close)

	// New() itself probes the real host for its ServiceManager/LogSource/
	// Runner — booting cleanly under that real probing is already part of
	// what this test proves. The fields are then pinned to the brief's
	// worst case explicitly below, the same way host_handler_test.go's
	// newHostTestServer swaps them for deterministic fakes: this package's
	// tests are allowed to reach into Server's unexported fields directly.
	srv := New(cfg, tc, st, hb, "test")
	t.Cleanup(srv.limiter.Stop)
	t.Cleanup(srv.subLimiter.Stop)
	srv.svcMgr = host.NewNone()
	srv.logSrc = host.NewNoneLog()
	srv.privilegesMode = host.PrivilegesModeDegraded

	// GET /api/updates would otherwise fall through to update.NewEngine's
	// default GitHub client (real api.github.com) — the one real-network
	// dependency this "stay green forever" test must not have. Point it at
	// a local fake instead: an empty releases array is enough to prove the
	// endpoint degrades cleanly, and the hit counter proves the override
	// actually took (not silently ignored, still hitting the real API).
	var githubHits int32
	fakeGithub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&githubHits, 1)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("[]"))
	}))
	t.Cleanup(fakeGithub.Close)
	srv.SetUpdateGithubBaseURL(fakeGithub.URL)

	h := srv.Handler()

	// GET /api/health: must be reachable with no session and no Telemt.
	r := httptest.NewRequest("GET", "/api/health", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/health = %d, want 200: %s", w.Code, w.Body)
	}

	// Login must succeed (it only checks the local password hash, never
	// Telemt) and the resulting session must actually authenticate a
	// subsequent request.
	_, cookie := login(t, h, "admin", testPassword)
	if cookie == nil {
		t.Fatal("login failed even though Telemt is irrelevant to authentication")
	}
	r = httptest.NewRequest("GET", "/api/auth/me", nil)
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/auth/me = %d, want 200 (session must work): %s", w.Code, w.Body)
	}

	// GET /api/host: every cap false, every hint present and non-empty —
	// the UI rule is "disabled with a manual command", never a dead
	// control with no explanation.
	r = httptest.NewRequest("GET", "/api/host", nil)
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/host = %d, want 200: %s", w.Code, w.Body)
	}
	var hostInfo hostInfo
	if err := json.Unmarshal(w.Body.Bytes(), &hostInfo); err != nil {
		t.Fatalf("decode /api/host: %v", err)
	}
	if hostInfo.Caps.RestartTelemt || hostInfo.Caps.RestartPanel || hostInfo.Caps.LogTail || hostInfo.Caps.LogStream || hostInfo.Caps.SelfUpdate {
		t.Errorf("/api/host caps = %+v, want all false", hostInfo.Caps)
	}
	for _, key := range []string{"restart_telemt", "restart_panel", "log_tail", "log_stream", "self_update"} {
		if hint := hostInfo.ManualCommands[key]; hint == "" {
			t.Errorf("/api/host manual_commands[%q] is empty, want a non-empty manual hint", key)
		}
	}

	// GET /api/telemt/info: reachable:false with a hint that names the
	// API, never files or config paths — the exact conflation the
	// invariant exists to prevent (the v0 failure mode).
	r = httptest.NewRequest("GET", "/api/telemt/info", nil)
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/telemt/info = %d, want 200: %s", w.Code, w.Body)
	}
	var info telemtInfoView
	if err := json.Unmarshal(w.Body.Bytes(), &info); err != nil {
		t.Fatalf("decode /api/telemt/info: %v", err)
	}
	if info.Reachable {
		t.Error("/api/telemt/info reachable = true, want false")
	}
	lowerHint := strings.ToLower(info.Hint)
	if !strings.Contains(lowerHint, "api") && !strings.Contains(lowerHint, "telemt.url") {
		t.Errorf("/api/telemt/info hint = %q, want it to name the Telemt API", info.Hint)
	}
	for _, word := range []string{"file", "config path", "config_path"} {
		if strings.Contains(lowerHint, word) {
			t.Errorf("/api/telemt/info hint = %q, must not mention files/config paths", info.Hint)
		}
	}

	// GET /api/users: a clean 502 telemt_unreachable, not a panic and not
	// a silent empty list masquerading as success.
	r = httptest.NewRequest("GET", "/api/users", nil)
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("GET /api/users = %d, want 502: %s", w.Code, w.Body)
	}
	var usersErr struct{ Code string }
	if err := json.Unmarshal(w.Body.Bytes(), &usersErr); err != nil {
		t.Fatalf("decode /api/users error: %v", err)
	}
	if usersErr.Code != "telemt_unreachable" {
		t.Errorf("/api/users error code = %q, want telemt_unreachable", usersErr.Code)
	}

	// GET /api/logs/tail: 501, no LogSource capability at all.
	r = httptest.NewRequest("GET", "/api/logs/tail?service=telemt", nil)
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusNotImplemented {
		t.Fatalf("GET /api/logs/tail = %d, want 501: %s", w.Code, w.Body)
	}

	// /sub/{token}: the route is registered (subpage enabled with a
	// secret) and must serve the uniform 404 without crashing, even though
	// the token index can never refresh from an unreachable Telemt.
	r = httptest.NewRequest("GET", "/sub/does-not-exist", nil)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusNotFound {
		t.Fatalf("GET /sub/{token} = %d, want 404: %s", w.Code, w.Body)
	}

	// GET /api/updates: still lists (Telemt unreachable, releases from the
	// fake GitHub above), never panics.
	r = httptest.NewRequest("GET", "/api/updates", nil)
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/updates = %d, want 200: %s", w.Code, w.Body)
	}
	var updates updatesStatusView
	if err := json.Unmarshal(w.Body.Bytes(), &updates); err != nil {
		t.Fatalf("decode /api/updates: %v", err)
	}
	if len(updates.Targets) != 2 {
		t.Errorf("/api/updates targets = %d, want 2 (telemt, panel) even when both are degraded", len(updates.Targets))
	}
	if atomic.LoadInt32(&githubHits) == 0 {
		t.Error("the fake GitHub server was never hit — SetUpdateGithubBaseURL did not take effect, GET /api/updates may have hit the real network instead")
	}
}

// TestAPIOnlyDegradation_M3Endpoints extends the invariant above to every
// endpoint task-2 of the M3 milestone added: an unreachable Telemt must
// never crash or hang any of them, and each must answer with its
// documented envelope (a clean 502/400/503, or — for the two endpoints with
// no Telemt dependency at all, GET /api/audit and GET /api/history — a
// normal 200). Kept as its own test, alongside (not inside)
// TestAPIOnlyDegradation, per that test's "do not weaken" note.
func TestAPIOnlyDegradation_M3Endpoints(t *testing.T) {
	hash, err := auth.HashPassword(testPassword)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	cfg := &config.Config{
		Telemt: config.TelemtConfig{URL: "http://127.0.0.1:1", ConfigEditMode: "api"},
		Auth:   config.AuthConfig{Username: "admin", PasswordHash: hash},
		Host: config.HostConfig{
			ServiceManager: "none",
			TelemtService:  "telemt",
			PanelService:   "telemt-panel",
		},
		Privileges: config.PrivilegesConfig{Mode: "auto", AgentSocket: "/nonexistent/agent.sock"},
	}

	tc := telemt.New(cfg.Telemt.URL, cfg.Telemt.AuthHeader)
	st, err := store.NewMemory("")
	if err != nil {
		t.Fatalf("store.NewMemory: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	hb := hub.New(hub.Config{}, tc, st)
	t.Cleanup(hb.Close)

	srv := New(cfg, tc, st, hb, "test")
	t.Cleanup(srv.limiter.Stop)
	t.Cleanup(srv.subLimiter.Stop)
	srv.svcMgr = host.NewNone()
	srv.logSrc = host.NewNoneLog()
	srv.privilegesMode = host.PrivilegesModeDegraded

	h := srv.Handler()
	_, cookie := login(t, h, "admin", testPassword)
	if cookie == nil {
		t.Fatal("login failed")
	}

	do := func(method, path string, mutating bool, body []byte) *httptest.ResponseRecorder {
		var r *http.Request
		if body != nil {
			r = httptest.NewRequest(method, path, strings.NewReader(string(body)))
			r.Header.Set("Content-Type", "application/json")
		} else {
			r = httptest.NewRequest(method, path, nil)
		}
		if mutating {
			r.Header.Set("Sec-Fetch-Site", "same-origin")
		}
		r.AddCookie(cookie)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}

	// GET /api/telemt/config: 502 telemt_unreachable, not a panic.
	w := do("GET", "/api/telemt/config", false, nil)
	if w.Code != http.StatusBadGateway {
		t.Errorf("GET /api/telemt/config = %d, want 502: %s", w.Code, w.Body)
	}

	// PATCH /api/telemt/config: 502 telemt_unreachable once past the
	// If-Match/body checks (this proves the handler doesn't hang trying to
	// reach Telemt for the caps probe either).
	r := httptest.NewRequest("PATCH", "/api/telemt/config", strings.NewReader(`{"sections":{"general":{"log_level":"debug"}}}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	r.Header.Set("If-Match", "some-revision")
	r.AddCookie(cookie)
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, r)
	if w2.Code != http.StatusBadGateway {
		t.Errorf("PATCH /api/telemt/config = %d, want 502: %s", w2.Code, w2.Body)
	}

	// POST /api/telemt/reload: 502 telemt_unreachable.
	w = do("POST", "/api/telemt/reload", true, []byte(`{}`))
	if w.Code != http.StatusBadGateway {
		t.Errorf("POST /api/telemt/reload = %d, want 502: %s", w.Code, w.Body)
	}

	// GET /api/telemt/reload/{id}: 502 telemt_unreachable for a
	// well-formed id.
	w = do("GET", "/api/telemt/reload/1", false, nil)
	if w.Code != http.StatusBadGateway {
		t.Errorf("GET /api/telemt/reload/1 = %d, want 502: %s", w.Code, w.Body)
	}

	// POST /api/telemt/restart: no Telemt dependency at all — the host
	// layer's own degraded caps (svcMgr=none) answer the request, 503
	// manual_restart_required, without ever touching Telemt.
	w = do("POST", "/api/telemt/restart", true, nil)
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("POST /api/telemt/restart = %d, want 503: %s", w.Code, w.Body)
	}
	var restartErr struct{ Code string }
	json.Unmarshal(w.Body.Bytes(), &restartErr)
	if restartErr.Code != "manual_restart_required" {
		t.Errorf("POST /api/telemt/restart code = %q, want manual_restart_required", restartErr.Code)
	}

	// GET /api/audit: no Telemt dependency, must still be a clean 200.
	w = do("GET", "/api/audit", false, nil)
	if w.Code != http.StatusOK {
		t.Errorf("GET /api/audit = %d, want 200: %s", w.Code, w.Body)
	}

	// GET /api/history: no Telemt dependency, must still be a clean 200
	// with an empty points array (nothing has been recorded).
	w = do("GET", "/api/history?metric=connections&range=15m", false, nil)
	if w.Code != http.StatusOK {
		t.Errorf("GET /api/history = %d, want 200: %s", w.Code, w.Body)
	}
}
