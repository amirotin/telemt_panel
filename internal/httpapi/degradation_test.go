package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

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
// surface degrades cleanly instead of panicking or hanging, including the
// hub-backed surfaces (GET /api/telemt/zero, GET /api/snapshot, GET
// /api/events — the SSE endpoint) added by later M3 tasks and the
// fetch-on-visit passthroughs added by M4 (TLS fingerprints, WEB runtime).
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

	// GET /api/telemt/zero: a clean 502 telemt_unreachable, same shape as
	// /api/users above — writeTelemtError's default branch, since a dial
	// failure never decodes as *telemt.APIError (F6, closing fix wave: this
	// task-6 contract-gap passthrough had no degradation coverage yet).
	r = httptest.NewRequest("GET", "/api/telemt/zero", nil)
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("GET /api/telemt/zero = %d, want 502: %s", w.Code, w.Body)
	}
	var zeroErr struct{ Code string }
	if err := json.Unmarshal(w.Body.Bytes(), &zeroErr); err != nil {
		t.Fatalf("decode /api/telemt/zero error: %v", err)
	}
	if zeroErr.Code != "telemt_unreachable" {
		t.Errorf("/api/telemt/zero error code = %q, want telemt_unreachable", zeroErr.Code)
	}

	// GET /api/telemt/tls-fingerprints: same rule for the fetch-on-visit
	// TLS passthrough (M4 task 1). An unreachable Telemt must read as
	// unreachable, never as the runtime_edge capability merely being off —
	// the frontend renders those two states differently (error retry vs a
	// Gated hint), so conflating them would hide a real outage.
	r = httptest.NewRequest("GET", "/api/telemt/tls-fingerprints", nil)
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("GET /api/telemt/tls-fingerprints = %d, want 502: %s", w.Code, w.Body)
	}
	var tlsErr struct{ Code string }
	if err := json.Unmarshal(w.Body.Bytes(), &tlsErr); err != nil {
		t.Fatalf("decode /api/telemt/tls-fingerprints error: %v", err)
	}
	if tlsErr.Code != "telemt_unreachable" {
		t.Errorf("/api/telemt/tls-fingerprints error code = %q, want telemt_unreachable", tlsErr.Code)
	}

	// A malformed limit is rejected by the panel itself, before Telemt is
	// ever contacted — so it stays a 400 even with Telemt down.
	r = httptest.NewRequest("GET", "/api/telemt/tls-fingerprints?limit=9999", nil)
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("GET /api/telemt/tls-fingerprints?limit=9999 = %d, want 400: %s", w.Code, w.Body)
	}

	// The WEB runtime passthroughs (M4 task 8b): the SAME rule again. An
	// unreachable Telemt is 502 telemt_unreachable on every one of them —
	// never 503 capability_unavailable (which the UI renders as "WEB is
	// switched off, here is how to turn it on") and never 501
	// capability_absent ("update Telemt"). Both of those would send an
	// operator to fix a config while the proxy is simply down.
	for _, path := range []string{
		"/api/telemt/web/sessions",
		"/api/telemt/web/sessions/ws1.0123456789abcdef0123456789abcdef.0000000000000001",
		"/api/telemt/web/operations/wo1.0123456789abcdef0123456789abcdef.0000000000000001",
	} {
		r = httptest.NewRequest("GET", path, nil)
		r.AddCookie(cookie)
		w = httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusBadGateway {
			t.Fatalf("GET %s = %d, want 502: %s", path, w.Code, w.Body)
		}
		var webErr struct{ Code string }
		if err := json.Unmarshal(w.Body.Bytes(), &webErr); err != nil {
			t.Fatalf("decode %s error: %v", path, err)
		}
		if webErr.Code != "telemt_unreachable" {
			t.Errorf("%s error code = %q, want telemt_unreachable", path, webErr.Code)
		}
	}

	// A query field off the WEB whitelist is rejected by the panel itself,
	// before Telemt is contacted — so it stays a 400 even with Telemt down.
	for _, query := range []string{"?bogus=1", "?limit=201"} {
		r = httptest.NewRequest("GET", "/api/telemt/web/sessions"+query, nil)
		r.AddCookie(cookie)
		w = httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest {
			t.Errorf("GET /api/telemt/web/sessions%s = %d, want 400: %s", query, w.Code, w.Body)
		}
	}

	// GET /api/snapshot?topics=stats: nothing has ever fetched successfully
	// (a fresh hub, unreachable Telemt), so the on-demand fetch fails and
	// every requested topic ends up empty — handleSnapshot's own documented
	// "all-empty" rule turns that into 502 telemt_unreachable, not a bare
	// empty 200.
	r = httptest.NewRequest("GET", "/api/snapshot?topics=stats", nil)
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("GET /api/snapshot?topics=stats = %d, want 502: %s", w.Code, w.Body)
	}

	// GET /api/events?topics=stats: the SSE endpoint itself must still
	// answer 200 text/event-stream and degrade to a source_error frame
	// (or, in principle, a heartbeat) instead of crashing or hanging.
	// Exercised over a real connection — not the canceled-context
	// ResponseRecorder trick used elsewhere in this package, which only
	// captures a snapshot already cached before the handler runs and can't
	// observe the poller's async broadcast — so this needs a real
	// subscriber. Kept sleepless: readSSEFrames/nextFrame (sse_test.go,
	// same package) bound the wait on a channel receive with a timeout,
	// never time.Sleep. The topic's poller fires its first fetch
	// immediately on subscribe (hub.go's runPoller starts its timer at 0),
	// and a dial to 127.0.0.1:1 fails fast, so the source_error should
	// arrive well within the bound.
	panelSrv := httptest.NewServer(h)
	t.Cleanup(panelSrv.Close)
	sseReq, err := http.NewRequest("GET", panelSrv.URL+"/api/events?topics=stats", nil)
	if err != nil {
		t.Fatalf("build GET /api/events request: %v", err)
	}
	sseReq.AddCookie(cookie)
	sseResp, err := http.DefaultClient.Do(sseReq)
	if err != nil {
		t.Fatalf("GET /api/events?topics=stats: %v", err)
	}
	t.Cleanup(func() { sseResp.Body.Close() })
	if sseResp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/events?topics=stats = %d, want 200", sseResp.StatusCode)
	}
	if ct := sseResp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("GET /api/events?topics=stats content-type = %q, want text/event-stream", ct)
	}
	frames := readSSEFrames(sseResp.Body)
	frame := nextFrame(t, frames, 5*time.Second)
	if frame.event != "source_error" && frame.event != "heartbeat" {
		t.Fatalf("GET /api/events?topics=stats first frame event = %q, want source_error or heartbeat", frame.event)
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
