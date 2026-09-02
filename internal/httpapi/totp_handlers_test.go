package httpapi

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/store"
)

func totpCodeAt(t *testing.T, secret string, at time.Time) string {
	t.Helper()
	decoded, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
	if err != nil {
		t.Fatalf("decode TOTP secret: %v", err)
	}
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(at.Unix()/auth.TOTPPeriodSeconds))
	mac := hmac.New(sha1.New, decoded)
	_, _ = mac.Write(counter[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	value := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", value%1_000_000)
}

func serveJSON(t *testing.T, h http.Handler, method, target string, cookie *http.Cookie, body any) *httptest.ResponseRecorder {
	t.Helper()
	var payload bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&payload).Encode(body); err != nil {
			t.Fatalf("encode request body: %v", err)
		}
	}
	r := httptest.NewRequest(method, target, &payload)
	r.Header.Set("Content-Type", "application/json")
	if method != http.MethodGet {
		r.Header.Set("Sec-Fetch-Site", "same-origin")
	}
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func loginWithTOTP(t *testing.T, h http.Handler, code string, remoteAddr string) (*httptest.ResponseRecorder, *http.Cookie) {
	t.Helper()
	body, err := json.Marshal(loginRequest{Username: "admin", Password: testPassword, TOTP: code})
	if err != nil {
		t.Fatalf("marshal login request: %v", err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if remoteAddr != "" {
		r.RemoteAddr = remoteAddr
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	for _, cookie := range w.Result().Cookies() {
		if cookie.Name == auth.CookieName {
			return w, cookie
		}
	}
	return w, nil
}

func responseErrorCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error response: %v", err)
	}
	return body.Code
}

func TestTOTPLifecycleLoginReplayRecoveryAndDisable(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()

	w, session := login(t, h, "admin", testPassword)
	if w.Code != http.StatusNoContent || session == nil {
		t.Fatalf("initial login = %d, cookie=%v", w.Code, session != nil)
	}

	w = serveJSON(t, h, http.MethodPost, "/api/auth/totp/setup", session, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("setup status = %d, body=%s", w.Code, w.Body.String())
	}
	var setup totpSetupResponse
	if err := json.Unmarshal(w.Body.Bytes(), &setup); err != nil {
		t.Fatalf("decode setup response: %v", err)
	}
	if setup.Secret == "" || !strings.HasPrefix(setup.ProvisioningURL, "otpauth://totp/") {
		t.Fatalf("invalid setup response: %+v", setup)
	}

	// Setup confirmation is not a login and must not consume the current
	// timestep. The same current code can immediately authenticate once; its
	// second use below is the replay that must fail.
	enableCode := totpCodeAt(t, setup.Secret, time.Now())
	w = serveJSON(t, h, http.MethodPost, "/api/auth/totp/enable", session, totpCodeRequest{Code: enableCode})
	if w.Code != http.StatusOK {
		t.Fatalf("enable status = %d, body=%s", w.Code, w.Body.String())
	}
	var enabled totpEnableResponse
	if err := json.Unmarshal(w.Body.Bytes(), &enabled); err != nil {
		t.Fatalf("decode enable response: %v", err)
	}
	if len(enabled.RecoveryCodes) != auth.TOTPRecoveryCodeCount {
		t.Fatalf("recovery codes = %d, want %d", len(enabled.RecoveryCodes), auth.TOTPRecoveryCodeCount)
	}

	w = serveJSON(t, h, http.MethodGet, "/api/auth/me", session, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("me status = %d", w.Code)
	}
	var me meResponse
	if err := json.Unmarshal(w.Body.Bytes(), &me); err != nil {
		t.Fatalf("decode me response: %v", err)
	}
	if !me.TOTPEnabled {
		t.Fatal("me response did not report enabled TOTP")
	}

	w, _ = login(t, h, "admin", testPassword)
	if w.Code != http.StatusUnauthorized || responseErrorCode(t, w) != "totp_required" {
		t.Fatalf("password-only login = %d %s", w.Code, w.Body.String())
	}

	currentCode := totpCodeAt(t, setup.Secret, time.Now())
	w, totpSession := loginWithTOTP(t, h, currentCode, "192.0.2.20:12000")
	if w.Code != http.StatusNoContent || totpSession == nil {
		t.Fatalf("TOTP login = %d, cookie=%v, body=%s", w.Code, totpSession != nil, w.Body.String())
	}
	assertSessionAuthMethod(t, srv.st, "password+totp")
	w, _ = loginWithTOTP(t, h, currentCode, "192.0.2.21:12000")
	if w.Code != http.StatusUnauthorized || responseErrorCode(t, w) != "invalid_credentials" {
		t.Fatalf("replayed TOTP login = %d %s", w.Code, w.Body.String())
	}

	w, recoverySession := loginWithTOTP(t, h, enabled.RecoveryCodes[0], "192.0.2.22:12000")
	if w.Code != http.StatusNoContent || recoverySession == nil {
		t.Fatalf("recovery login = %d, cookie=%v, body=%s", w.Code, recoverySession != nil, w.Body.String())
	}
	assertSessionAuthMethod(t, srv.st, "password+recovery")
	w, _ = loginWithTOTP(t, h, enabled.RecoveryCodes[0], "192.0.2.23:12000")
	if w.Code != http.StatusUnauthorized || responseErrorCode(t, w) != "invalid_credentials" {
		t.Fatalf("reused recovery login = %d %s", w.Code, w.Body.String())
	}

	w = serveJSON(t, h, http.MethodDelete, "/api/auth/totp", session, nil)
	if w.Code != http.StatusNoContent {
		t.Fatalf("disable status = %d, body=%s", w.Code, w.Body.String())
	}
	w, passwordSession := login(t, h, "admin", testPassword)
	if w.Code != http.StatusNoContent || passwordSession == nil {
		t.Fatalf("password login after disable = %d, cookie=%v", w.Code, passwordSession != nil)
	}
}

func assertSessionAuthMethod(t *testing.T, st store.Store, want string) {
	t.Helper()
	sessions, err := st.ListSessions()
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}
	for _, session := range sessions {
		if session.AuthMethod == want {
			return
		}
	}
	t.Fatalf("no session with auth method %q: %+v", want, sessions)
}

func TestTOTPSetupReplacementInvalidatesPreviousSecret(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()
	_, session := login(t, h, "admin", testPassword)

	w := serveJSON(t, h, http.MethodPost, "/api/auth/totp/setup", session, nil)
	var first totpSetupResponse
	if err := json.Unmarshal(w.Body.Bytes(), &first); err != nil {
		t.Fatalf("decode first setup: %v", err)
	}
	w = serveJSON(t, h, http.MethodPost, "/api/auth/totp/setup", session, nil)
	var second totpSetupResponse
	if err := json.Unmarshal(w.Body.Bytes(), &second); err != nil {
		t.Fatalf("decode second setup: %v", err)
	}
	if first.Secret == second.Secret {
		t.Fatal("replacement setup reused the secret")
	}

	w = serveJSON(t, h, http.MethodPost, "/api/auth/totp/enable", session, totpCodeRequest{Code: totpCodeAt(t, first.Secret, time.Now())})
	if w.Code != http.StatusBadRequest || responseErrorCode(t, w) != "invalid_totp" {
		t.Fatalf("old setup enable = %d %s", w.Code, w.Body.String())
	}
}

func TestTOTPGlobalFailureLimitSpansClientIPs(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()
	_, session := login(t, h, "admin", testPassword)
	w := serveJSON(t, h, http.MethodPost, "/api/auth/totp/setup", session, nil)
	var setup totpSetupResponse
	if err := json.Unmarshal(w.Body.Bytes(), &setup); err != nil {
		t.Fatalf("decode setup: %v", err)
	}
	w = serveJSON(t, h, http.MethodPost, "/api/auth/totp/enable", session, totpCodeRequest{Code: totpCodeAt(t, setup.Secret, time.Now())})
	if w.Code != http.StatusOK {
		t.Fatalf("enable status = %d, body=%s", w.Code, w.Body.String())
	}

	for attempt := 0; attempt < 5; attempt++ {
		w, _ = loginWithTOTP(t, h, "000000", fmt.Sprintf("192.0.2.%d:12000", attempt+30))
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d status = %d, want 401", attempt+1, w.Code)
		}
	}
	w, _ = loginWithTOTP(t, h, "000000", "192.0.2.99:12000")
	if w.Code != http.StatusTooManyRequests || responseErrorCode(t, w) != "rate_limited" {
		t.Fatalf("globally limited attempt = %d %s", w.Code, w.Body.String())
	}
}
