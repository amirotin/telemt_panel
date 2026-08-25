package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

// telemtErr configures a canned upstream failure for one fakeTelemt
// operation. raw=true simulates an unrouted request on an older Telemt
// build: a bare status with a non-enveloped body, which the SDK surfaces as
// an *APIError with a generic (non-"not_found") code — the signal
// writeTelemtError uses to distinguish "route doesn't exist" from "route
// exists, resource doesn't".
type telemtErr struct {
	status  int
	code    string
	message string
	raw     bool
}

// fakeTelemt is a minimal in-memory Telemt double covering the users
// surface: GET/POST /v1/users, GET /v1/stats/users/quota, and the
// per-user PATCH/DELETE/reset-quota/rotate-secret/enable/disable routes.
// Each mutating operation can be told to fail via its *Err field instead of
// performing the change, and PATCH captures the raw upstream request body
// so tests can assert the tri-state merge-patch bytes exactly.
type fakeTelemt struct {
	mu       sync.Mutex
	users    map[string]telemt.UserInfo
	quota    map[string]telemt.QuotaEntry
	hasQuota bool

	lastPatchBody []byte

	createErr     *telemtErr
	patchErr      *telemtErr
	deleteErr     *telemtErr
	resetQuotaErr *telemtErr
	rotateErr     *telemtErr
	enabledErr    *telemtErr
	quotaErr      *telemtErr

	// failUsersCountdown, when > 0, counts down on each GET /v1/users call
	// and fails the one that brings it to 0 (then leaves it there, so
	// later calls succeed again) — used by the subpage-index tests to
	// fail one specific GET /v1/users call (e.g. the index's own
	// background Refresh, which may not be the very next such call) while
	// others around it still have to succeed.
	failUsersCountdown int
}

// failUsersOnNthCall arms a failure of the nth subsequent GET /v1/users
// call (1 = the very next call).
func (f *fakeTelemt) failUsersOnNthCall(n int) {
	f.mu.Lock()
	f.failUsersCountdown = n
	f.mu.Unlock()
}

func newFakeTelemt(users ...telemt.UserInfo) *fakeTelemt {
	f := &fakeTelemt{users: make(map[string]telemt.UserInfo)}
	for _, u := range users {
		f.users[u.Username] = u
	}
	return f
}

func (f *fakeTelemt) server(t *testing.T) *telemt.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(f.route))
	t.Cleanup(srv.Close)
	return telemt.New(srv.URL, "")
}

func (f *fakeTelemt) route(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()

	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/v1/users":
		f.writeUsersLocked(w)
	case r.Method == http.MethodGet && r.URL.Path == "/v1/stats/users/quota":
		f.writeQuotaLocked(w)
	case r.Method == http.MethodPost && r.URL.Path == "/v1/users":
		f.handleCreateLocked(w, r)
	case r.Method == http.MethodPatch && strings.HasPrefix(r.URL.Path, "/v1/users/"):
		f.handlePatchLocked(w, r, usersPathUsername(r.URL.Path))
	case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/v1/users/"):
		f.handleDeleteLocked(w, usersPathUsername(r.URL.Path))
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/reset-quota"):
		f.handleResetQuotaLocked(w, usersPathUsername(strings.TrimSuffix(r.URL.Path, "/reset-quota")))
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/rotate-secret"):
		f.handleRotateLocked(w, usersPathUsername(strings.TrimSuffix(r.URL.Path, "/rotate-secret")))
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/enable"):
		f.handleSetEnabledLocked(w, usersPathUsername(strings.TrimSuffix(r.URL.Path, "/enable")), true)
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/disable"):
		f.handleSetEnabledLocked(w, usersPathUsername(strings.TrimSuffix(r.URL.Path, "/disable")), false)
	default:
		w.WriteHeader(http.StatusNotFound)
		io.WriteString(w, "not found")
	}
}

// usersPathUsername extracts the username segment from a /v1/users/{u}...
// path.
func usersPathUsername(path string) string {
	rest := strings.TrimPrefix(path, "/v1/users/")
	if i := strings.Index(rest, "/"); i >= 0 {
		rest = rest[:i]
	}
	return rest
}

func (f *fakeTelemt) writeUsersLocked(w http.ResponseWriter) {
	if f.failUsersCountdown > 0 {
		f.failUsersCountdown--
		if f.failUsersCountdown == 0 {
			w.WriteHeader(http.StatusInternalServerError)
			io.WriteString(w, "simulated upstream failure")
			return
		}
	}
	names := make([]string, 0, len(f.users))
	for name := range f.users {
		names = append(names, name)
	}
	sort.Strings(names)
	out := make([]telemt.UserInfo, len(names))
	for i, name := range names {
		out[i] = f.users[name]
	}
	writeEnvelope(w, http.StatusOK, out)
}

// quotaWireEntry mirrors the real GET /v1/stats/users/quota wire shape
// (src/api/users/view.rs::build_user_quota_list in the Telemt 3.5.2
// source): an object with a users array, not a map keyed by username.
type quotaWireEntry struct {
	Username           string `json:"username"`
	DataQuotaBytes     uint64 `json:"data_quota_bytes"`
	UsedBytes          uint64 `json:"used_bytes"`
	LastResetEpochSecs int64  `json:"last_reset_epoch_secs"`
}

func (f *fakeTelemt) writeQuotaLocked(w http.ResponseWriter) {
	if f.quotaErr != nil {
		writeTelemtErrBody(w, *f.quotaErr)
		return
	}
	if !f.hasQuota {
		w.WriteHeader(http.StatusNotFound)
		io.WriteString(w, "not found")
		return
	}
	names := make([]string, 0, len(f.quota))
	for name := range f.quota {
		names = append(names, name)
	}
	sort.Strings(names)
	entries := make([]quotaWireEntry, len(names))
	for i, name := range names {
		q := f.quota[name]
		entries[i] = quotaWireEntry{
			Username:           name,
			DataQuotaBytes:     q.DataQuotaBytes,
			UsedBytes:          q.UsedBytes,
			LastResetEpochSecs: q.LastResetEpochSecs,
		}
	}
	writeEnvelope(w, http.StatusOK, struct {
		Users []quotaWireEntry `json:"users"`
	}{Users: entries})
}

func (f *fakeTelemt) handleCreateLocked(w http.ResponseWriter, r *http.Request) {
	if f.createErr != nil {
		writeTelemtErrBody(w, *f.createErr)
		return
	}
	var req telemt.CreateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	secret := req.Secret
	if secret == "" {
		secret = "11111111111111111111111111111111"[:32]
	}
	u := telemt.UserInfo{
		Username:  req.Username,
		Enabled:   true,
		InRuntime: false,
		Links: telemt.UserLinks{
			Classic: []string{"tg://proxy?server=1.2.3.4&port=443&secret=" + secret},
		},
	}
	if req.Enabled != nil {
		u.Enabled = *req.Enabled
	}
	f.users[u.Username] = u
	writeEnvelope(w, http.StatusCreated, struct {
		User   telemt.UserInfo `json:"user"`
		Secret string          `json:"secret"`
	}{User: u, Secret: secret})
}

func (f *fakeTelemt) handlePatchLocked(w http.ResponseWriter, r *http.Request, username string) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	f.lastPatchBody = body

	if f.patchErr != nil {
		writeTelemtErrBody(w, *f.patchErr)
		return
	}
	u, ok := f.users[username]
	if !ok {
		writeTelemtErrBody(w, telemtErr{status: http.StatusNotFound, code: "not_found", message: "no such user"})
		return
	}

	// Apply a "secret" patch to the stored links, mirroring the real
	// Telemt behavior the subpage verify-on-hit tests depend on: a secret
	// patch must actually change what ExtractSecret later reads back.
	// Other patch fields aren't modeled here — no existing test needs it.
	var patch struct {
		Secret *string `json:"secret"`
	}
	if err := json.Unmarshal(body, &patch); err == nil && patch.Secret != nil {
		u.Links = telemt.UserLinks{Classic: []string{"tg://proxy?server=1.2.3.4&port=443&secret=" + *patch.Secret}}
	}
	f.users[username] = u

	writeEnvelope(w, http.StatusOK, u)
}

func (f *fakeTelemt) handleDeleteLocked(w http.ResponseWriter, username string) {
	if f.deleteErr != nil {
		writeTelemtErrBody(w, *f.deleteErr)
		return
	}
	if _, ok := f.users[username]; !ok {
		writeTelemtErrBody(w, telemtErr{status: http.StatusNotFound, code: "not_found", message: "no such user"})
		return
	}
	delete(f.users, username)
	writeEnvelope(w, http.StatusOK, struct {
		Username  string `json:"username"`
		InRuntime bool   `json:"in_runtime"`
	}{Username: username, InRuntime: false})
}

func (f *fakeTelemt) handleResetQuotaLocked(w http.ResponseWriter, username string) {
	if f.resetQuotaErr != nil {
		writeTelemtErrBody(w, *f.resetQuotaErr)
		return
	}
	writeEnvelope(w, http.StatusOK, struct {
		Username           string `json:"username"`
		UsedBytes          uint64 `json:"used_bytes"`
		LastResetEpochSecs int64  `json:"last_reset_epoch_secs"`
	}{Username: username, UsedBytes: 0, LastResetEpochSecs: 999})
}

func (f *fakeTelemt) handleRotateLocked(w http.ResponseWriter, username string) {
	if f.rotateErr != nil {
		writeTelemtErrBody(w, *f.rotateErr)
		return
	}
	u, ok := f.users[username]
	if !ok {
		writeTelemtErrBody(w, telemtErr{status: http.StatusNotFound, code: "not_found", message: "no such user"})
		return
	}
	const newSecret = "22222222222222222222222222222222"
	u.Links = telemt.UserLinks{Classic: []string{"tg://proxy?server=1.2.3.4&port=443&secret=" + newSecret[:32]}}
	f.users[username] = u
	writeEnvelope(w, http.StatusOK, struct {
		User   telemt.UserInfo `json:"user"`
		Secret string          `json:"secret"`
	}{User: u, Secret: newSecret[:32]})
}

func (f *fakeTelemt) handleSetEnabledLocked(w http.ResponseWriter, username string, enabled bool) {
	if f.enabledErr != nil {
		writeTelemtErrBody(w, *f.enabledErr)
		return
	}
	u, ok := f.users[username]
	if !ok {
		writeTelemtErrBody(w, telemtErr{status: http.StatusNotFound, code: "not_found", message: "no such user"})
		return
	}
	u.Enabled = enabled
	f.users[username] = u
	writeEnvelope(w, http.StatusAccepted, u)
}

func writeEnvelope(w http.ResponseWriter, status int, data any) {
	raw, err := json.Marshal(data)
	if err != nil {
		panic(err)
	}
	w.WriteHeader(status)
	fmt.Fprintf(w, `{"ok":true,"data":%s,"revision":"r"}`, raw)
}

func writeTelemtErrBody(w http.ResponseWriter, e telemtErr) {
	if e.raw {
		w.WriteHeader(e.status)
		io.WriteString(w, "not found")
		return
	}
	w.WriteHeader(e.status)
	fmt.Fprintf(w, `{"ok":false,"error":{"code":%q,"message":%q},"request_id":1}`, e.code, e.message)
}

// newUsersTestServer builds a logged-in Server backed by fake, with the
// subpage module enabled unless subpageEnabled is false.
func newUsersTestServer(t *testing.T, fake *fakeTelemt, subpageEnabled bool) (*Server, *http.Cookie) {
	t.Helper()
	hash, err := auth.HashPassword(testPassword)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	cfg := &config.Config{
		Auth:    config.AuthConfig{Username: "admin", PasswordHash: hash},
		Subpage: config.SubpageConfig{Enabled: subpageEnabled, Secret: "panel-secret"},
	}
	st, err := store.NewMemory("")
	if err != nil {
		t.Fatalf("store.NewMemory: %v", err)
	}
	tc := fake.server(t)
	hb := hub.New(hub.Config{}, tc, st)
	t.Cleanup(hb.Close)

	srv := New(cfg, tc, st, hb, "test")
	t.Cleanup(srv.limiter.Stop)
	t.Cleanup(srv.subLimiter.Stop)

	h := srv.Handler()
	_, cookie := login(t, h, "admin", testPassword)
	if cookie == nil {
		t.Fatal("expected a successful login")
	}
	return srv, cookie
}

// mutatingJSON builds a same-origin request with a JSON body, passing CSRF.
func mutatingJSON(t *testing.T, method, target string, cookie *http.Cookie, body any) *http.Request {
	t.Helper()
	buf, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	r := mutating(method, target, cookie)
	r.Body = io.NopCloser(bytes.NewReader(buf))
	r.Header.Set("Content-Type", "application/json")
	return r
}

func aliceFixture() telemt.UserInfo {
	return telemt.UserInfo{
		Username: "alice",
		Enabled:  true,
		Links: telemt.UserLinks{
			Classic: []string{"tg://proxy?server=1.2.3.4&port=443&secret=" + testUserSecret},
		},
	}
}

func bobFixture() telemt.UserInfo {
	// No links at all: ExtractSecret fails, so bob must never get a sub_url.
	return telemt.UserInfo{Username: "bob", Enabled: true}
}

func TestHandleListUsersRequiresSession(t *testing.T) {
	fake := newFakeTelemt(aliceFixture())
	srv, _ := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/api/users", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestHandleListUsersMergesQuotaAndSubURL(t *testing.T) {
	fake := newFakeTelemt(aliceFixture(), bobFixture())
	fake.hasQuota = true
	fake.quota = map[string]telemt.QuotaEntry{
		"alice": {DataQuotaBytes: 5000, UsedBytes: 1234, LastResetEpochSecs: 111},
	}
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	r := httptest.NewRequest("GET", "/api/users", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body)
	}

	var users []userResponse
	if err := json.Unmarshal(w.Body.Bytes(), &users); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(users) != 2 {
		t.Fatalf("len(users) = %d, want 2", len(users))
	}
	byName := map[string]userResponse{}
	for _, u := range users {
		byName[u.Username] = u
	}

	alice := byName["alice"]
	if alice.Quota == nil || alice.Quota.UsedBytes != 1234 || alice.Quota.LastResetEpochSecs != 111 {
		t.Errorf("alice.Quota = %+v", alice.Quota)
	}
	if !strings.Contains(alice.SubURL, "/sub/") {
		t.Errorf("alice.SubURL = %q, want a /sub/ link", alice.SubURL)
	}

	bob := byName["bob"]
	if bob.Quota != nil {
		t.Errorf("bob.Quota = %+v, want nil (not in quota list)", bob.Quota)
	}
	if bob.SubURL != "" {
		t.Errorf("bob.SubURL = %q, want empty (no extractable link secret)", bob.SubURL)
	}
}

func TestHandleListUsersWithoutQuotaCapability(t *testing.T) {
	fake := newFakeTelemt(aliceFixture())
	fake.hasQuota = false
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	r := httptest.NewRequest("GET", "/api/users", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body)
	}
	var users []userResponse
	if err := json.Unmarshal(w.Body.Bytes(), &users); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if users[0].Quota != nil {
		t.Errorf("Quota = %+v, want nil when capability absent", users[0].Quota)
	}
}

func TestHandleListUsersSubURLOmittedWhenSubpageDisabled(t *testing.T) {
	fake := newFakeTelemt(aliceFixture())
	srv, cookie := newUsersTestServer(t, fake, false)
	h := srv.Handler()

	r := httptest.NewRequest("GET", "/api/users", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var users []userResponse
	if err := json.Unmarshal(w.Body.Bytes(), &users); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if users[0].SubURL != "" {
		t.Errorf("SubURL = %q, want empty when subpage disabled", users[0].SubURL)
	}
}

func TestHandleListUsersTelemtUnreachable(t *testing.T) {
	hash, err := auth.HashPassword(testPassword)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	cfg := &config.Config{Auth: config.AuthConfig{Username: "admin", PasswordHash: hash}}
	st, err := store.NewMemory("")
	if err != nil {
		t.Fatalf("store.NewMemory: %v", err)
	}
	tc := telemt.New("http://127.0.0.1:1", "")
	hb := hub.New(hub.Config{}, tc, st)
	t.Cleanup(hb.Close)
	srv := New(cfg, tc, st, hb, "test")
	t.Cleanup(srv.limiter.Stop)
	t.Cleanup(srv.subLimiter.Stop)
	h := srv.Handler()
	_, cookie := login(t, h, "admin", testPassword)

	r := httptest.NewRequest("GET", "/api/users", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", w.Code)
	}
	var body map[string]string
	json.Unmarshal(w.Body.Bytes(), &body)
	if body["code"] != "telemt_unreachable" {
		t.Errorf("code = %q, want telemt_unreachable", body["code"])
	}
}

func TestHandleCreateUser(t *testing.T) {
	fake := newFakeTelemt()
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	req := mutatingJSON(t, "POST", "/api/users", cookie, telemt.CreateUserRequest{Username: "carol"})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body)
	}
	var resp userSecretResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.User.Username != "carol" || resp.Secret == "" {
		t.Errorf("resp = %+v", resp)
	}

	entries, err := srv.st.ListAudit(1)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if len(entries) != 1 || entries[0].Action != "user.create" || entries[0].Subject != "carol" {
		t.Fatalf("audit = %+v", entries)
	}
}

func TestHandleCreateUserExists(t *testing.T) {
	fake := newFakeTelemt()
	fake.createErr = &telemtErr{status: http.StatusConflict, code: "user_exists", message: "already exists"}
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	req := mutatingJSON(t, "POST", "/api/users", cookie, telemt.CreateUserRequest{Username: "carol"})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", w.Code)
	}
	var body map[string]string
	json.Unmarshal(w.Body.Bytes(), &body)
	if body["code"] != "user_exists" {
		t.Errorf("code = %q", body["code"])
	}
}

// TestHandlePatchUserTriState is the byte-level assertion the brief
// requires: a set field, an explicit null (remove), an omitted field (left
// unchanged) and an unknown field (dropped) must produce exactly one JSON
// object upstream with only the known, present keys — set field as its
// value, null field as literal null, nothing else.
func TestHandlePatchUserTriState(t *testing.T) {
	fake := newFakeTelemt(aliceFixture())
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	body := map[string]any{
		"data_quota_bytes": 2048,
		"max_tcp_conns":    nil,
		"bogus_field":      "should be dropped",
	}
	req := mutatingJSON(t, "PATCH", "/api/users/alice", cookie, body)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body)
	}

	const want = `{"data_quota_bytes":2048,"max_tcp_conns":null}`
	if got := string(fake.lastPatchBody); got != want {
		t.Errorf("upstream patch body = %s, want %s", got, want)
	}

	entries, err := srv.st.ListAudit(1)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if len(entries) != 1 || entries[0].Action != "user.patch" || entries[0].Subject != "alice" {
		t.Fatalf("audit = %+v", entries)
	}
}

func TestHandlePatchUserOmittedFieldProducesEmptyBody(t *testing.T) {
	fake := newFakeTelemt(aliceFixture())
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	req := mutatingJSON(t, "PATCH", "/api/users/alice", cookie, map[string]any{})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body)
	}
	if got := string(fake.lastPatchBody); got != `{}` {
		t.Errorf("upstream patch body = %s, want {}", got)
	}
}

func TestHandlePatchUserNotFound(t *testing.T) {
	fake := newFakeTelemt()
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	req := mutatingJSON(t, "PATCH", "/api/users/ghost", cookie, map[string]any{"enabled": true})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
}

func TestHandlePatchUserReadOnly(t *testing.T) {
	fake := newFakeTelemt(aliceFixture())
	fake.patchErr = &telemtErr{status: http.StatusForbidden, code: "read_only", message: "api is read-only"}
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	req := mutatingJSON(t, "PATCH", "/api/users/alice", cookie, map[string]any{"enabled": true})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
	var body map[string]string
	json.Unmarshal(w.Body.Bytes(), &body)
	if body["code"] != "read_only" {
		t.Errorf("code = %q", body["code"])
	}
}

// TestHandlePatchUserSecretNullRejected covers finding 2: both
// openapi.yaml (UserPatch.secret is a plain, non-nullable string) and
// 07-telemt-sdk.md ("secret non-nullable") forbid removing secret via
// merge patch, so an explicit "secret":null must be rejected locally,
// before ever reaching Telemt.
func TestHandlePatchUserSecretNullRejected(t *testing.T) {
	fake := newFakeTelemt(aliceFixture())
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	req := mutatingJSON(t, "PATCH", "/api/users/alice", cookie, map[string]any{"secret": nil})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body = %s", w.Code, w.Body)
	}
	if fake.lastPatchBody != nil {
		t.Errorf("upstream PATCH was called with body %s, want no upstream request at all", fake.lastPatchBody)
	}

	// login() itself records a "login" audit entry; assert no user.patch
	// entry was added on top of it, rather than asserting the log is empty.
	entries, err := srv.st.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	for _, e := range entries {
		if e.Action == "user.patch" {
			t.Fatalf("audit = %+v, want no user.patch entry for a rejected request", entries)
		}
	}
}

// TestHandlePatchUserUnmappedClientErrorPassesThrough covers finding 3: an
// upstream 4xx APIError whose code isn't one of the specifically-mapped
// ones (user_exists/last_user_forbidden/read_only/not_found) must surface
// with Telemt's own status and code, not get flattened into 502
// telemt_unreachable — an admin's bad input isn't a connectivity problem.
func TestHandlePatchUserUnmappedClientErrorPassesThrough(t *testing.T) {
	fake := newFakeTelemt(aliceFixture())
	fake.patchErr = &telemtErr{status: http.StatusConflict, code: "revision_conflict", message: "config changed"}
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	req := mutatingJSON(t, "PATCH", "/api/users/alice", cookie, map[string]any{"enabled": true})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (passed through from upstream)", w.Code)
	}
	var body map[string]string
	json.Unmarshal(w.Body.Bytes(), &body)
	if body["code"] != "revision_conflict" {
		t.Errorf("code = %q, want revision_conflict passed through, not telemt_unreachable", body["code"])
	}
}

// TestHandleCreateUserUnmappedServerErrorStaysUnreachable is the other
// half of finding 3's fix: an upstream 5xx (or otherwise non-4xx)
// APIError with an unmapped code should still collapse to 502
// telemt_unreachable — the passthrough is specifically for 4xx client-input
// problems, not a blanket "always show Telemt's raw status."
func TestHandleCreateUserUnmappedServerErrorStaysUnreachable(t *testing.T) {
	fake := newFakeTelemt()
	fake.createErr = &telemtErr{status: http.StatusInternalServerError, code: "internal_error", message: "boom"}
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	req := mutatingJSON(t, "POST", "/api/users", cookie, telemt.CreateUserRequest{Username: "carol"})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", w.Code)
	}
	var body map[string]string
	json.Unmarshal(w.Body.Bytes(), &body)
	if body["code"] != "telemt_unreachable" {
		t.Errorf("code = %q, want telemt_unreachable", body["code"])
	}
}

func TestHandleDeleteUser(t *testing.T) {
	fake := newFakeTelemt(aliceFixture())
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	w := httptest.NewRecorder()
	h.ServeHTTP(w, mutating("DELETE", "/api/users/alice", cookie))
	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", w.Code)
	}

	entries, err := srv.st.ListAudit(1)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if len(entries) != 1 || entries[0].Action != "user.delete" || entries[0].Subject != "alice" {
		t.Fatalf("audit = %+v", entries)
	}
}

func TestHandleDeleteUserLastUserForbidden(t *testing.T) {
	fake := newFakeTelemt(aliceFixture())
	fake.deleteErr = &telemtErr{status: http.StatusConflict, code: "last_user_forbidden", message: "cannot delete last user"}
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	w := httptest.NewRecorder()
	h.ServeHTTP(w, mutating("DELETE", "/api/users/alice", cookie))
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", w.Code)
	}
	var body map[string]string
	json.Unmarshal(w.Body.Bytes(), &body)
	if body["code"] != "last_user_forbidden" {
		t.Errorf("code = %q", body["code"])
	}
}

func TestHandleResetQuota(t *testing.T) {
	fake := newFakeTelemt(aliceFixture())
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	w := httptest.NewRecorder()
	h.ServeHTTP(w, mutating("POST", "/api/users/alice/reset-quota", cookie))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body)
	}
	var body struct {
		Username           string `json:"username"`
		UsedBytes          uint64 `json:"used_bytes"`
		LastResetEpochSecs int64  `json:"last_reset_epoch_secs"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Username != "alice" || body.UsedBytes != 0 {
		t.Errorf("body = %+v", body)
	}

	entries, err := srv.st.ListAudit(1)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if len(entries) != 1 || entries[0].Action != "quota.reset" || entries[0].Subject != "alice" {
		t.Fatalf("audit = %+v", entries)
	}
}

func TestHandleRotateSecretChangesSubURL(t *testing.T) {
	fake := newFakeTelemt(aliceFixture())
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	before := httptest.NewRecorder()
	h.ServeHTTP(before, mutating("GET", "/api/users/alice", cookie))
	var beforeUser userResponse
	json.Unmarshal(before.Body.Bytes(), &beforeUser)

	w := httptest.NewRecorder()
	h.ServeHTTP(w, mutating("POST", "/api/users/alice/rotate-secret", cookie))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body)
	}
	var resp userSecretResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Secret == "" {
		t.Error("expected a non-empty rotated secret")
	}
	if resp.User.SubURL == beforeUser.SubURL {
		t.Errorf("sub_url did not change after secret rotation: %q", resp.User.SubURL)
	}

	entries, err := srv.st.ListAudit(1)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if len(entries) != 1 || entries[0].Action != "secret.rotate" || entries[0].Subject != "alice" {
		t.Fatalf("audit = %+v", entries)
	}
}

func TestHandleRotateSecretCapabilityAbsent(t *testing.T) {
	fake := newFakeTelemt(aliceFixture())
	fake.rotateErr = &telemtErr{status: http.StatusNotFound, raw: true}
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	w := httptest.NewRecorder()
	h.ServeHTTP(w, mutating("POST", "/api/users/alice/rotate-secret", cookie))
	if w.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501", w.Code)
	}
	var body map[string]string
	json.Unmarshal(w.Body.Bytes(), &body)
	if body["code"] != "capability_absent" {
		t.Errorf("code = %q", body["code"])
	}
}

func TestHandleSetEnabled(t *testing.T) {
	fake := newFakeTelemt(aliceFixture())
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	req := mutatingJSON(t, "PUT", "/api/users/alice/enabled", cookie, map[string]bool{"enabled": false})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body)
	}
	var u userResponse
	if err := json.Unmarshal(w.Body.Bytes(), &u); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if u.Enabled {
		t.Error("expected enabled=false in response")
	}

	entries, err := srv.st.ListAudit(1)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if len(entries) != 1 || entries[0].Action != "user.enabled" || entries[0].Subject != "alice" || entries[0].Detail != "enabled=false" {
		t.Fatalf("audit = %+v", entries)
	}
}

func TestHandleSetEnabledCapabilityAbsent(t *testing.T) {
	fake := newFakeTelemt(aliceFixture())
	fake.enabledErr = &telemtErr{status: http.StatusMethodNotAllowed, code: "method_not_allowed", message: "no such route"}
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	req := mutatingJSON(t, "PUT", "/api/users/alice/enabled", cookie, map[string]bool{"enabled": true})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501", w.Code)
	}
}

// TestHandleSetEnabledRequiresEnabledKey covers finding 1: openapi.yaml
// marks "enabled" required on this endpoint. A body missing the key (or
// carrying an explicit null) must be rejected with 400 rather than
// silently defaulting to false and disabling the user — encoding/json
// unmarshaling null into a plain bool is a no-op, not an error, which is
// exactly the trap a naive struct decode falls into.
func TestHandleSetEnabledRequiresEnabledKey(t *testing.T) {
	fake := newFakeTelemt(aliceFixture())
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	req := mutatingJSON(t, "PUT", "/api/users/alice/enabled", cookie, map[string]any{})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body = %s", w.Code, w.Body)
	}

	fake.mu.Lock()
	stillEnabled := fake.users["alice"].Enabled
	fake.mu.Unlock()
	if !stillEnabled {
		t.Error("user was disabled despite a rejected request")
	}

	// login() itself records a "login" audit entry; assert no user.enabled
	// entry was added on top of it, rather than asserting the log is empty.
	entries, err := srv.st.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	for _, e := range entries {
		if e.Action == "user.enabled" {
			t.Fatalf("audit = %+v, want no user.enabled entry for a rejected request", entries)
		}
	}
}

// TestHandleSetEnabledNullRejected is the explicit-null half of finding 1:
// {"enabled":null} must be treated the same as a missing key, not as
// false.
func TestHandleSetEnabledNullRejected(t *testing.T) {
	fake := newFakeTelemt(aliceFixture())
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	req := mutatingJSON(t, "PUT", "/api/users/alice/enabled", cookie, map[string]any{"enabled": nil})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body = %s", w.Code, w.Body)
	}
}

func TestHandleGetUserNotFound(t *testing.T) {
	fake := newFakeTelemt(aliceFixture())
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	w := httptest.NewRecorder()
	h.ServeHTTP(w, mutating("GET", "/api/users/ghost", cookie))
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
}

func TestHandleListUsersDegradesOnQuotaTransportError(t *testing.T) {
	fake := newFakeTelemt(aliceFixture())
	fake.hasQuota = true
	fake.quotaErr = &telemtErr{status: http.StatusInternalServerError, code: "internal_error", message: "boom"}
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	w := httptest.NewRecorder()
	h.ServeHTTP(w, mutating("GET", "/api/users", cookie))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (list must degrade rather than fail)", w.Code)
	}
	var users []userResponse
	if err := json.Unmarshal(w.Body.Bytes(), &users); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if users[0].Quota != nil {
		t.Errorf("Quota = %+v, want nil when quota list itself errors", users[0].Quota)
	}
}
