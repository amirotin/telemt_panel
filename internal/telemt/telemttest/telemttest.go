// Package telemttest is an in-memory fake of the Telemt control API
// (07-telemt-sdk.md §SDK-8), replacing the 0.x panel's mock-server.mjs.
// Handlers build responses from the real telemt.* wire types and marshal
// them through the same {ok,data,revision}/{ok,error,request_id} envelope
// Telemt uses, so a test exercising telemttest exercises the SDK's actual
// decode path rather than a hand-rolled JSON fixture.
package telemttest

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

// Scenario toggles the fake's behavior to exercise the panel's degraded-mode
// handling against realistic Telemt build/config variations.
type Scenario struct {
	// OldBuild simulates a Telemt build that predates the quota, reload and
	// config-API routes: those paths 404 with a bare body (no {ok,error}
	// envelope) — capability probes must read this as "route absent", not a
	// well-formed error (client.go's http_error vs envelope-404 distinction).
	OldBuild bool
	// ReadOnly simulates `read_only = true`: every mutation 403s with the
	// read_only error code instead of applying.
	ReadOnly bool
	// RuntimeEdge simulates `runtime_edge_enabled`. Telemt defaults this
	// false, so the Scenario zero value already matches a stock config.
	RuntimeEdge bool
	// MinimalRuntimeOff simulates `minimal_runtime_enabled = false`. Telemt
	// defaults this true (the gate ON), so the Scenario zero value also
	// matches a stock config; set true to simulate the gate being disabled.
	MinimalRuntimeOff bool
	// BodyLimitBytes overrides the request body limit used for PATCH
	// /v1/config (default 64KiB, Telemt's own default —
	// config/defaults.rs::default_api_request_body_limit_bytes). Tests set
	// this low to trigger payload_too_large without sending a huge body.
	BodyLimitBytes int
	// GeneratedAtEpochSecs overrides every fixture response's
	// generated_at_epoch_secs field (default, when zero, is
	// defaultGeneratedAtEpochSecs — see generatedAt). Real Telemt stamps
	// this field with a fresh wall-clock read on (most) requests
	// independent of whether the underlying data changed at all
	// (confirmed against the Rust source — see internal/hub's diffKey doc
	// comment); this knob lets a hub test drive that exact scenario
	// (poll twice with identical data but a bumped timestamp, via
	// SetScenario) without needing a real clock or a sleep.
	GeneratedAtEpochSecs int64
}

const defaultBodyLimitBytes = 64 * 1024

// defaultGeneratedAtEpochSecs is generatedAt's fallback when
// Scenario.GeneratedAtEpochSecs is left at its zero value — the fixed
// value every generated_at_epoch_secs field in this package used before
// the field became scenario-controllable.
const defaultGeneratedAtEpochSecs = 5000

// Server is an in-memory fake Telemt instance. Create with New, point an
// *telemt.Client at Server.URL, and Close when done.
type Server struct {
	*httptest.Server

	mu           sync.Mutex
	scenario     Scenario
	users        map[string]telemt.UserInfo
	secrets      map[string]string
	quota        map[string]telemt.QuotaEntry
	revisionSeq  int
	nextReloadID uint64
	reloads      map[uint64]telemt.ReloadStatus
}

// New starts a fake Telemt server seeded with one default user ("alice").
func New(scenario Scenario) *Server {
	s := &Server{
		scenario: scenario,
		users:    map[string]telemt.UserInfo{},
		secrets:  map[string]string{},
		quota:    map[string]telemt.QuotaEntry{},
		reloads:  map[uint64]telemt.ReloadStatus{},
	}
	s.seedDefaultUser()
	s.Server = httptest.NewServer(http.HandlerFunc(s.handle))
	return s
}

// SetScenario swaps the active scenario, e.g. to flip read_only mid-test.
func (s *Server) SetScenario(scenario Scenario) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.scenario = scenario
}

// Handler returns the fake's http.Handler directly, for a caller that wants
// to host it on its own listener/address instead of the httptest.Server
// New already started on an OS-assigned port — cmd/telemt-mock is the one
// such caller (it needs a fixed, scriptable port for a dev frontend/panel
// to point at). Tests within this module should keep using New and its
// embedded *httptest.Server.URL/.Close as before.
func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(s.handle)
}

func (s *Server) seedDefaultUser() {
	quota := uint64(10 << 30)
	s.users["alice"] = telemt.UserInfo{
		Username:           "alice",
		Enabled:            true,
		InRuntime:          true,
		DataQuotaBytes:     &quota,
		CurrentConnections: 2,
		ActiveUniqueIPs:    1,
		ActiveIPList:       []string{"203.0.113.10"},
		RecentUniqueIPs:    1,
		RecentIPList:       []string{"203.0.113.10"},
		TotalOctets:        123456789,
		Links: telemt.UserLinks{
			Classic:    []string{"tg://proxy?server=example.com&port=443&secret=deadbeefdeadbeefdeadbeefdeadbeef"},
			Secure:     []string{},
			TLS:        []string{},
			TLSDomains: []telemt.TLSDomainLink{},
		},
	}
	s.secrets["alice"] = "deadbeefdeadbeefdeadbeefdeadbeef"
	s.quota["alice"] = telemt.QuotaEntry{DataQuotaBytes: quota, UsedBytes: 1 << 20, LastResetEpochSecs: 1000}
}

func (s *Server) revision() string {
	return "rev-" + strconv.Itoa(s.revisionSeq)
}

func (s *Server) bumpRevision() string {
	s.revisionSeq++
	return s.revision()
}

// generatedAt returns the generated_at_epoch_secs value every fixture
// response in this package uses — Scenario.GeneratedAtEpochSecs when set,
// else defaultGeneratedAtEpochSecs. No locking of its own: every call site
// is a handler method invoked from s.handle, which already holds s.mu for
// the whole request (same pattern as revision/bodyLimit).
func (s *Server) generatedAt() int64 {
	if s.scenario.GeneratedAtEpochSecs != 0 {
		return s.scenario.GeneratedAtEpochSecs
	}
	return defaultGeneratedAtEpochSecs
}

func writeOK(w http.ResponseWriter, status int, data any, revision string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(struct {
		OK       bool   `json:"ok"`
		Data     any    `json:"data"`
		Revision string `json:"revision"`
	}{true, data, revision})
}

func writeErr(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(struct {
		OK        bool   `json:"ok"`
		Error     any    `json:"error"`
		RequestID uint64 `json:"request_id"`
	}{false, struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}{code, message}, 1})
}

// writeBareNotFound simulates a route that doesn't exist on an old Telemt
// build: a 404 with no JSON envelope at all, matching Rust's default hyper
// "not found" fallback — the shape client.go's isRouteAbsent/probe*
// functions must distinguish from a well-formed not_found error.
func writeBareNotFound(w http.ResponseWriter) {
	w.WriteHeader(http.StatusNotFound)
	_, _ = w.Write([]byte("404 page not found"))
}

func writeReadOnly(w http.ResponseWriter) {
	writeErr(w, http.StatusForbidden, "read_only", "API runs in read-only mode")
}

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	path := r.URL.Path
	query := r.URL.RawQuery

	switch {
	case r.Method == http.MethodGet && path == "/v1/health":
		writeOK(w, http.StatusOK, telemt.HealthData{Status: "ok", ReadOnly: s.scenario.ReadOnly}, s.revision())
		return
	case r.Method == http.MethodGet && path == "/v1/health/ready":
		writeOK(w, http.StatusOK, telemt.ReadyData{
			Ready: true, Status: "ready", AdmissionOpen: true,
			HealthyUpstreams: 1, TotalUpstreams: 1,
		}, s.revision())
		return
	case r.Method == http.MethodGet && path == "/v1/system/info":
		writeOK(w, http.StatusOK, telemt.SystemInfoData{
			Version: "3.5.2", TargetArch: "x86_64", TargetOS: "linux", BuildProfile: "release",
			ProcessStartedAtEpochSec: 1000, UptimeSeconds: 3600,
			ConfigPath: "/etc/telemt/telemt.toml", ConfigHash: s.revision(), ConfigReloadCount: 1,
		}, s.revision())
		return
	case r.Method == http.MethodGet && path == "/v1/stats/summary":
		writeOK(w, http.StatusOK, telemt.SummaryData{
			UptimeSeconds: 3600, ConnectionsTotal: 100, ConnectionsBadTotal: 5,
			HandshakeTimeoutsTotal: 1, ConfiguredUsers: uint64(len(s.users)),
			ConnectionsBadByClass:    []telemt.ClassCount{{Class: "timeout", Total: 5}},
			HandshakeFailuresByClass: []telemt.ClassCount{{Class: "tls", Total: 1}},
		}, s.revision())
		return
	case r.Method == http.MethodGet && path == "/v1/stats/zero/all":
		s.handleZeroAll(w)
		return
	case r.Method == http.MethodGet && path == "/v1/stats/upstreams":
		s.handleUpstreams(w)
		return
	case r.Method == http.MethodGet && path == "/v1/stats/dcs":
		s.handleDCs(w)
		return
	case r.Method == http.MethodGet && path == "/v1/stats/me-writers":
		s.handleMeWriters(w)
		return
	case r.Method == http.MethodGet && path == "/v1/stats/minimal/all":
		s.handleMinimalAll(w)
		return
	case r.Method == http.MethodGet && (path == "/v1/users" || path == "/v1/stats/users"):
		s.handleUsersList(w)
		return
	case r.Method == http.MethodGet && path == "/v1/stats/users/quota":
		s.handleQuotaList(w)
		return
	case r.Method == http.MethodGet && path == "/v1/stats/users/active-ips":
		s.handleActiveIPs(w)
		return
	case r.Method == http.MethodPost && path == "/v1/users":
		s.handleCreateUser(w, r)
		return
	case r.Method == http.MethodGet && path == "/v1/runtime/gates":
		s.handleGates(w)
		return
	case r.Method == http.MethodGet && path == "/v1/runtime/initialization":
		s.handleInitialization(w)
		return
	case r.Method == http.MethodGet && path == "/v1/limits/effective":
		s.handleEffectiveLimits(w)
		return
	case r.Method == http.MethodGet && (path == "/v1/runtime/me-pool-state" || path == "/v1/runtime/me_pool_state"):
		s.handleMePoolState(w)
		return
	case r.Method == http.MethodGet && (path == "/v1/runtime/me-quality" || path == "/v1/runtime/me_quality"):
		s.handleMeQuality(w)
		return
	case r.Method == http.MethodGet && (path == "/v1/runtime/upstream-quality" || path == "/v1/runtime/upstream_quality"):
		s.handleUpstreamQuality(w)
		return
	case r.Method == http.MethodGet && (path == "/v1/runtime/nat-stun" || path == "/v1/runtime/nat_stun"):
		s.handleNatStun(w)
		return
	case r.Method == http.MethodGet && path == "/v1/runtime/me-selftest":
		s.handleMeSelftest(w)
		return
	case r.Method == http.MethodGet && path == "/v1/runtime/connections/summary":
		s.handleConnectionsSummary(w)
		return
	case r.Method == http.MethodGet && path == "/v1/runtime/events/recent":
		s.handleRecentEvents(w, query)
		return
	case r.Method == http.MethodGet && path == "/v1/runtime/tls-fingerprints":
		s.handleTLSFingerprints(w, query)
		return
	case r.Method == http.MethodGet && path == "/v1/security/posture":
		s.handlePosture(w)
		return
	case r.Method == http.MethodGet && path == "/v1/security/whitelist":
		s.handleWhitelist(w)
		return
	case r.Method == http.MethodGet && path == "/v1/config":
		s.handleGetConfig(w)
		return
	case r.Method == http.MethodPatch && path == "/v1/config":
		s.handlePatchConfig(w, r, query)
		return
	case r.Method == http.MethodPost && path == "/v1/system/reload":
		s.handleReload(w, r)
		return
	case r.Method == http.MethodGet && strings.HasPrefix(path, "/v1/system/reload/"):
		s.handleReloadStatus(w, strings.TrimPrefix(path, "/v1/system/reload/"))
		return
	}

	if username, ok := userActionRoute(path, "/rotate-secret"); ok && r.Method == http.MethodPost {
		s.handleRotateSecret(w, username)
		return
	}
	if username, ok := userActionRoute(path, "/enable"); ok && r.Method == http.MethodPost {
		s.handleSetEnabled(w, username, true)
		return
	}
	if username, ok := userActionRoute(path, "/disable"); ok && r.Method == http.MethodPost {
		s.handleSetEnabled(w, username, false)
		return
	}
	if username, ok := userActionRoute(path, "/reset-quota"); ok && r.Method == http.MethodPost {
		s.handleResetQuota(w, username)
		return
	}
	if username, ok := strings.CutPrefix(path, "/v1/users/"); ok && !strings.Contains(username, "/") && username != "" {
		switch r.Method {
		case http.MethodGet:
			s.handleGetUser(w, username)
		case http.MethodPatch:
			s.handlePatchUser(w, r, username)
		case http.MethodDelete:
			s.handleDeleteUser(w, username)
		default:
			writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed", "unsupported method")
		}
		return
	}

	writeBareNotFound(w)
}

// userActionRoute matches "/v1/users/{username}{suffix}" and returns username.
func userActionRoute(path, suffix string) (string, bool) {
	rest, ok := strings.CutPrefix(path, "/v1/users/")
	if !ok {
		return "", false
	}
	username, ok := strings.CutSuffix(rest, suffix)
	if !ok || username == "" || strings.Contains(username, "/") {
		return "", false
	}
	return username, true
}
