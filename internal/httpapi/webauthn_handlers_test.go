package httpapi

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/go-webauthn/webauthn/protocol/webauthncbor"
	"github.com/go-webauthn/webauthn/protocol/webauthncose"
	wa "github.com/go-webauthn/webauthn/webauthn"
)

type signedPasskeyFixture struct {
	flowID            string
	credentialID      []byte
	userHandle        []byte
	authenticatorData []byte
	clientDataJSON    []byte
	signature         []byte
	initialSignCount  uint32
	assertedSignCount uint32
}

func newSignedPasskeyFixture(t *testing.T, srv *Server, initialSignCount, assertedSignCount uint32) signedPasskeyFixture {
	t.Helper()
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publicKey, err := webauthncbor.Marshal(webauthncose.EC2PublicKeyData{
		PublicKeyData: webauthncose.PublicKeyData{
			KeyType:   int64(webauthncose.EllipticKey),
			Algorithm: int64(webauthncose.AlgES256),
		},
		Curve:  int64(webauthncose.P256),
		XCoord: privateKey.X.FillBytes(make([]byte, 32)),
		YCoord: privateKey.Y.FillBytes(make([]byte, 32)),
	})
	if err != nil {
		t.Fatal(err)
	}

	credentialID := bytes.Repeat([]byte{0x2a}, 32)
	userHandle := bytes.Repeat([]byte{0x4b}, 64)
	challenge := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x19}, 32))
	clientDataJSON, err := json.Marshal(map[string]any{
		"type": "webauthn.get", "challenge": challenge, "origin": "https://example.org", "crossOrigin": false,
	})
	if err != nil {
		t.Fatal(err)
	}
	rpIDHash := sha256.Sum256([]byte("example.org"))
	authenticatorData := make([]byte, 37)
	copy(authenticatorData, rpIDHash[:])
	authenticatorData[32] = 0x01
	binary.BigEndian.PutUint32(authenticatorData[33:], assertedSignCount)
	clientDataHash := sha256.Sum256(clientDataJSON)
	signedData := append(append([]byte(nil), authenticatorData...), clientDataHash[:]...)
	digest := sha256.Sum256(signedData)
	signature, err := ecdsa.SignASN1(rand.Reader, privateKey, digest[:])
	if err != nil {
		t.Fatal(err)
	}

	if _, err := srv.st.GetOrCreateWebAuthnUserHandle(userHandle); err != nil {
		t.Fatal(err)
	}
	credential := wa.Credential{
		ID: credentialID, PublicKey: publicKey,
		Flags:         wa.CredentialFlags{UserPresent: true},
		Authenticator: wa.Authenticator{SignCount: initialSignCount},
	}
	credentialData, err := json.Marshal(credential)
	if err != nil {
		t.Fatal(err)
	}
	credentialIDString := base64.RawURLEncoding.EncodeToString(credentialID)
	if err := srv.st.AddWebAuthnCredential(store.WebAuthnCredential{
		ID: credentialIDString, Name: "Signed test key", CredentialData: credentialData,
		SignCount: initialSignCount, Created: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}

	flowID := "signed-passkey-flow"
	ceremonyData, err := json.Marshal(webAuthnCeremony{Session: wa.SessionData{Challenge: challenge}})
	if err != nil {
		t.Fatal(err)
	}
	if err := srv.st.PutWebAuthnChallenge(store.WebAuthnChallenge{
		FlowHash: auth.HashToken(flowID), Kind: webAuthnLoginKind, SessionData: ceremonyData,
		Origin: "https://example.org", RPID: "example.org", Expires: time.Now().Add(time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	return signedPasskeyFixture{
		flowID: flowID, credentialID: credentialID, userHandle: userHandle,
		authenticatorData: authenticatorData, clientDataJSON: clientDataJSON, signature: signature,
		initialSignCount: initialSignCount, assertedSignCount: assertedSignCount,
	}
}

func (f signedPasskeyFixture) requestBody(t *testing.T, credentialID, userHandle []byte) []byte {
	t.Helper()
	credentialIDString := base64.RawURLEncoding.EncodeToString(credentialID)
	body, err := json.Marshal(map[string]any{
		"flow_id": f.flowID,
		"credential": map[string]any{
			"id": credentialIDString, "rawId": credentialIDString, "type": "public-key", "future": true,
			"response": map[string]any{
				"authenticatorData": base64.RawURLEncoding.EncodeToString(f.authenticatorData),
				"clientDataJSON":    base64.RawURLEncoding.EncodeToString(f.clientDataJSON),
				"signature":         base64.RawURLEncoding.EncodeToString(f.signature),
				"userHandle":        base64.RawURLEncoding.EncodeToString(userHandle),
			},
		},
		"future": true,
	})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func finishSignedPasskey(t *testing.T, h http.Handler, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "https://example.org/api/auth/webauthn/login/finish", bytes.NewReader(body))
	r.TLS = testTLSState()
	r.RemoteAddr = "192.0.2.44:44000"
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("User-Agent", "Mozilla/5.0 (iPhone) Safari/18.0")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestAuthMethodsOnlyExposePasskeyAvailability(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()
	r := httptest.NewRequest(http.MethodGet, "/api/auth/methods", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK || w.Body.String() != "{\"passkey_available\":false}\n" {
		t.Fatalf("methods = %d %s", w.Code, w.Body.String())
	}
}

func TestWebAuthnRegistrationBindsTrustedOriginAndRPID(t *testing.T) {
	srv := newTestServer(t)
	srv.cfg.TrustedProxyPrefixes = []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}
	h := srv.Handler()
	w, cookie := login(t, h, "admin", testPassword)
	if w.Code != http.StatusNoContent {
		t.Fatalf("login status = %d", w.Code)
	}

	body := bytes.NewBufferString(`{"name":"Phone"}`)
	r := httptest.NewRequest(http.MethodPost, "http://internal:8080/api/auth/webauthn/register/begin", body)
	r.RemoteAddr = "127.0.0.1:42000"
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	r.Header.Set("X-Forwarded-Host", "panel.example:8443")
	r.Header.Set("X-Forwarded-Proto", "https")
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("registration begin = %d %s", w.Code, w.Body.String())
	}
	var response webAuthnBeginResponse
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	challenge, err := srv.st.ConsumeWebAuthnChallenge(auth.HashToken(response.FlowID), webAuthnRegisterKind, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if challenge.Origin != "https://panel.example:8443" || challenge.RPID != "panel.example" {
		t.Fatalf("challenge origin/RP = %q / %q", challenge.Origin, challenge.RPID)
	}
	var ceremony webAuthnCeremony
	if err := json.Unmarshal(challenge.SessionData, &ceremony); err != nil {
		t.Fatal(err)
	}
	if ceremony.CredentialName != "Phone" || ceremony.Session.RelyingPartyID != "panel.example" {
		t.Fatalf("ceremony = %+v", ceremony)
	}
}

func TestWebAuthnBodyDecoderRejectsUnreadData(t *testing.T) {
	for _, endpoint := range []struct {
		name          string
		path          string
		body          string
		authenticated bool
	}{
		{name: "registration begin", path: "/api/auth/webauthn/register/begin", body: `{"name":"Phone"}`, authenticated: true},
		{name: "registration finish envelope", path: "/api/auth/webauthn/register/finish", body: `{"flow_id":"missing","credential":{}}`, authenticated: true},
		{name: "login finish envelope", path: "/api/auth/webauthn/login/finish", body: `{"flow_id":"missing","credential":{}}`},
	} {
		for _, suffix := range []struct {
			name  string
			value string
		}{
			{name: "trailing JSON", value: `{}`},
			{name: "overflow tail", value: strings.Repeat(" ", webAuthnBodyLimit)},
		} {
			t.Run(endpoint.name+"/"+suffix.name, func(t *testing.T) {
				srv := newTestServer(t)
				h := srv.Handler()
				var cookie *http.Cookie
				wantSessions, wantAudit := 0, 0
				if endpoint.authenticated {
					w, issued := login(t, h, "admin", testPassword)
					if w.Code != http.StatusNoContent || issued == nil {
						t.Fatalf("setup login = %d", w.Code)
					}
					cookie, wantSessions, wantAudit = issued, 1, 1
				}
				r := httptest.NewRequest(http.MethodPost, endpoint.path, strings.NewReader(endpoint.body+suffix.value))
				r.Header.Set("Content-Type", "application/json")
				if endpoint.authenticated {
					r.Header.Set("Sec-Fetch-Site", "same-origin")
					r.AddCookie(cookie)
				}
				w := httptest.NewRecorder()
				h.ServeHTTP(w, r)
				if w.Code != http.StatusBadRequest {
					t.Fatalf("status = %d, want 400: %s", w.Code, w.Body.String())
				}
				var problem struct{ Code string }
				if err := json.Unmarshal(w.Body.Bytes(), &problem); err != nil {
					t.Fatal(err)
				}
				if problem.Code != "bad_request" {
					t.Fatalf("error code = %q, want bad_request", problem.Code)
				}
				sessions, err := srv.st.ListSessions()
				if err != nil || len(sessions) != wantSessions {
					t.Fatalf("sessions = %+v, err %v; want %d", sessions, err, wantSessions)
				}
				credentials, err := srv.st.ListWebAuthnCredentials()
				if err != nil || len(credentials) != 0 {
					t.Fatalf("credentials = %+v, err %v; want none", credentials, err)
				}
				entries, err := srv.st.ListAudit(10)
				if err != nil || len(entries) != wantAudit {
					t.Fatalf("audit entries = %+v, err %v; want %d setup entries only", entries, err, wantAudit)
				}
			})
		}
	}
}

func TestWebAuthnMalformedLoginFinishCountsTowardRateLimit(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()
	body := `{"flow_id":"missing","credential":{}}{}`
	for attempt := 0; attempt < 5; attempt++ {
		w := finishSignedPasskey(t, h, []byte(body))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("attempt %d status = %d, want 400: %s", attempt, w.Code, w.Body.String())
		}
	}
	w := finishSignedPasskey(t, h, []byte(body))
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("sixth attempt status = %d, want 429: %s", w.Code, w.Body.String())
	}
}

func TestSignedPasskeyLoginIssuesSessionAfterCredentialUpdate(t *testing.T) {
	srv := newTestServer(t)
	fixture := newSignedPasskeyFixture(t, srv, 7, 8)
	prior := store.Session{IDHash: "prior-session", Created: time.Now().Add(-time.Hour), LastSeen: time.Now().Add(-time.Hour), AuthMethod: "password"}
	if err := srv.st.PutSession(prior); err != nil {
		t.Fatal(err)
	}
	tracking := &authIssuanceStore{Store: srv.st}
	srv.st = tracking
	body := fixture.requestBody(t, fixture.credentialID, fixture.userHandle)
	w := finishSignedPasskey(t, srv.Handler(), body)
	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204: %s", w.Code, w.Body.String())
	}
	if strings.Join(tracking.calls, ",") != "credential,session" {
		t.Fatalf("store calls = %v, want credential before session", tracking.calls)
	}
	var cookie *http.Cookie
	for _, candidate := range w.Result().Cookies() {
		if candidate.Name == auth.CookieName {
			cookie = candidate
		}
	}
	if cookie == nil {
		t.Fatal("passkey login did not set a session cookie")
	}
	sessions, err := srv.st.ListSessions()
	if err != nil || len(sessions) != 2 {
		t.Fatalf("sessions = %+v, err %v", sessions, err)
	}
	var session store.Session
	for _, candidate := range sessions {
		if candidate.IDHash == auth.HashToken(cookie.Value) {
			session = candidate
		}
	}
	if session.IDHash != auth.HashToken(cookie.Value) || session.AuthMethod != "passkey" || session.IP != "192.0.2.44" || session.UserAgentLabel == "" || !session.Created.Equal(session.LastSeen) {
		t.Fatalf("session = %+v, cookie hash %q", session, auth.HashToken(cookie.Value))
	}
	if _, ok, err := srv.st.GetSession(prior.IDHash); err != nil || !ok {
		t.Fatalf("prior session was removed: ok %v, err %v", ok, err)
	}
	credentialID := base64.RawURLEncoding.EncodeToString(fixture.credentialID)
	credential, ok, err := srv.st.GetWebAuthnCredential(credentialID)
	if err != nil || !ok || credential.SignCount != fixture.assertedSignCount || credential.LastUsed.IsZero() {
		t.Fatalf("credential = %+v, ok %v, err %v", credential, ok, err)
	}
	entries, err := srv.st.ListAudit(10)
	if err != nil || len(entries) != 1 || entries[0].Action != "login" {
		t.Fatalf("audit entries = %+v, err %v", entries, err)
	}

	replay := finishSignedPasskey(t, srv.Handler(), body)
	if replay.Code != http.StatusUnauthorized || len(replay.Result().Cookies()) != 0 {
		t.Fatalf("replay = %d, cookies %+v; want 401 without cookie", replay.Code, replay.Result().Cookies())
	}
	sessions, _ = srv.st.ListSessions()
	entries, _ = srv.st.ListAudit(10)
	if len(sessions) != 2 || len(entries) != 1 || strings.Join(tracking.calls, ",") != "credential,session" {
		t.Fatalf("replay side effects: sessions %d audit %d calls %v", len(sessions), len(entries), tracking.calls)
	}
}

func TestSignedPasskeySessionFailureLeavesChallengeSpentAndCredentialAdvanced(t *testing.T) {
	srv := newTestServer(t)
	fixture := newSignedPasskeyFixture(t, srv, 11, 12)
	tracking := &authIssuanceStore{Store: srv.st, putSessionErr: errors.New("session store unavailable")}
	srv.st = tracking
	body := fixture.requestBody(t, fixture.credentialID, fixture.userHandle)
	w := finishSignedPasskey(t, srv.Handler(), body)
	if w.Code != http.StatusInternalServerError || len(w.Result().Cookies()) != 0 {
		t.Fatalf("login = %d, cookies %+v; want 500 without cookie", w.Code, w.Result().Cookies())
	}
	var problem struct{ Code string }
	if err := json.Unmarshal(w.Body.Bytes(), &problem); err != nil || problem.Code != "internal_error" {
		t.Fatalf("problem = %+v, err %v; want internal_error", problem, err)
	}
	if strings.Join(tracking.calls, ",") != "credential,session" {
		t.Fatalf("store calls = %v, want credential before failed session", tracking.calls)
	}
	credentialID := base64.RawURLEncoding.EncodeToString(fixture.credentialID)
	credential, ok, err := srv.st.GetWebAuthnCredential(credentialID)
	if err != nil || !ok || credential.SignCount != fixture.assertedSignCount || credential.LastUsed.IsZero() {
		t.Fatalf("credential after session failure = %+v, ok %v, err %v", credential, ok, err)
	}
	sessions, _ := srv.st.ListSessions()
	entries, _ := srv.st.ListAudit(10)
	if len(sessions) != 0 || len(entries) != 0 {
		t.Fatalf("session failure side effects: sessions %+v audit %+v", sessions, entries)
	}

	replay := finishSignedPasskey(t, srv.Handler(), body)
	if replay.Code != http.StatusUnauthorized || len(replay.Result().Cookies()) != 0 {
		t.Fatalf("replay = %d, cookies %+v; want spent challenge", replay.Code, replay.Result().Cookies())
	}
	if strings.Join(tracking.calls, ",") != "credential,session" {
		t.Fatalf("replay reached persistence: %v", tracking.calls)
	}
}

func TestSignedPasskeyCASFailurePreventsSessionIssuance(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
	}{
		{name: "counter conflict", err: store.ErrWebAuthnCredentialChanged},
		{name: "credential revoked", err: store.ErrWebAuthnCredentialNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := newTestServer(t)
			fixture := newSignedPasskeyFixture(t, srv, 3, 4)
			tracking := &authIssuanceStore{Store: srv.st, updateCredentialErr: tc.err}
			srv.st = tracking
			w := finishSignedPasskey(t, srv.Handler(), fixture.requestBody(t, fixture.credentialID, fixture.userHandle))
			if w.Code != http.StatusUnauthorized || len(w.Result().Cookies()) != 0 {
				t.Fatalf("login = %d, cookies %+v; want 401 without cookie", w.Code, w.Result().Cookies())
			}
			if strings.Join(tracking.calls, ",") != "credential" {
				t.Fatalf("store calls = %v, want failed credential CAS only", tracking.calls)
			}
			credentialID := base64.RawURLEncoding.EncodeToString(fixture.credentialID)
			credential, _, _ := srv.st.GetWebAuthnCredential(credentialID)
			if credential.SignCount != fixture.initialSignCount || !credential.LastUsed.IsZero() {
				t.Fatalf("credential changed despite CAS failure: %+v", credential)
			}
			sessions, _ := srv.st.ListSessions()
			if len(sessions) != 0 {
				t.Fatalf("sessions = %+v, want none", sessions)
			}
		})
	}
}

func TestSignedPasskeyCloneWarningPreventsPersistence(t *testing.T) {
	srv := newTestServer(t)
	fixture := newSignedPasskeyFixture(t, srv, 9, 8)
	tracking := &authIssuanceStore{Store: srv.st}
	srv.st = tracking
	w := finishSignedPasskey(t, srv.Handler(), fixture.requestBody(t, fixture.credentialID, fixture.userHandle))
	if w.Code != http.StatusUnauthorized || len(w.Result().Cookies()) != 0 {
		t.Fatalf("login = %d, cookies %+v; want 401 without cookie", w.Code, w.Result().Cookies())
	}
	if len(tracking.calls) != 0 {
		t.Fatalf("clone warning reached persistence: %v", tracking.calls)
	}
	sessions, _ := srv.st.ListSessions()
	entries, _ := srv.st.ListAudit(10)
	if len(sessions) != 0 || len(entries) != 1 || entries[0].Action != "login.failed" {
		t.Fatalf("clone warning side effects: sessions %+v audit %+v", sessions, entries)
	}
}

func TestSignedPasskeyLoginBindsUserHandleAndCredentialID(t *testing.T) {
	for _, tc := range []struct {
		name       string
		credential func(signedPasskeyFixture) []byte
		handle     func(signedPasskeyFixture) []byte
	}{
		{
			name:       "wrong user handle",
			credential: func(f signedPasskeyFixture) []byte { return f.credentialID },
			handle:     func(signedPasskeyFixture) []byte { return bytes.Repeat([]byte{0x6c}, 64) },
		},
		{
			name:       "wrong credential id",
			credential: func(signedPasskeyFixture) []byte { return bytes.Repeat([]byte{0x7d}, 32) },
			handle:     func(f signedPasskeyFixture) []byte { return f.userHandle },
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := newTestServer(t)
			fixture := newSignedPasskeyFixture(t, srv, 5, 6)
			tracking := &authIssuanceStore{Store: srv.st}
			srv.st = tracking
			w := finishSignedPasskey(t, srv.Handler(), fixture.requestBody(t, tc.credential(fixture), tc.handle(fixture)))
			if w.Code != http.StatusUnauthorized || len(w.Result().Cookies()) != 0 {
				t.Fatalf("login = %d, cookies %+v; want 401 without cookie", w.Code, w.Result().Cookies())
			}
			if len(tracking.calls) != 0 {
				t.Fatalf("binding failure reached persistence: %v", tracking.calls)
			}
			sessions, _ := srv.st.ListSessions()
			if len(sessions) != 0 {
				t.Fatalf("sessions = %+v, want none", sessions)
			}
		})
	}
}

func TestWebAuthnOriginIgnoresUntrustedForwarding(t *testing.T) {
	srv := newTestServer(t)
	r := httptest.NewRequest(http.MethodPost, "http://panel.local:48280/api/auth/webauthn/login/begin", nil)
	r.RemoteAddr = "192.0.2.10:42000"
	r.Header.Set("X-Forwarded-Host", "attacker.example")
	r.Header.Set("X-Forwarded-Proto", "https")
	origin, rpID, err := srv.webAuthnOrigin(r)
	if err != nil {
		t.Fatal(err)
	}
	if origin != "http://panel.local:48280" || rpID != "panel.local" {
		t.Fatalf("origin/RP = %q / %q", origin, rpID)
	}
}

func TestWebAuthnOriginCanonicalizesHostCase(t *testing.T) {
	srv := newTestServer(t)
	r := httptest.NewRequest(http.MethodPost, "https://PANEL.EXAMPLE:8443/api/auth/webauthn/login/begin", nil)
	r.TLS = testTLSState()
	origin, rpID, err := srv.webAuthnOrigin(r)
	if err != nil {
		t.Fatal(err)
	}
	if origin != "https://panel.example:8443" || rpID != "panel.example" {
		t.Fatalf("origin/RP = %q / %q", origin, rpID)
	}
}

func TestWebAuthnChallengeOriginChangeIsRejectedAndSpent(t *testing.T) {
	srv := newTestServer(t)
	r := httptest.NewRequest(http.MethodPost, "https://panel.example/api/auth/webauthn/login/begin", nil)
	r.TLS = testTLSState()
	instance, origin, rpID, err := srv.webAuthnForRequest(r)
	if err != nil {
		t.Fatal(err)
	}
	_, session, err := instance.BeginDiscoverableLogin()
	if err != nil {
		t.Fatal(err)
	}
	flowID, err := srv.putWebAuthnChallenge(webAuthnLoginKind, "", origin, rpID, session)
	if err != nil {
		t.Fatal(err)
	}
	changed := httptest.NewRequest(http.MethodPost, "https://other.example/api/auth/webauthn/login/finish", nil)
	changed.TLS = testTLSState()
	if _, _, err := srv.consumeWebAuthnChallenge(changed, flowID, webAuthnLoginKind); err != store.ErrWebAuthnChallenge {
		t.Fatalf("changed origin error = %v", err)
	}
	if _, _, err := srv.consumeWebAuthnChallenge(r, flowID, webAuthnLoginKind); err != store.ErrWebAuthnChallenge {
		t.Fatalf("reused challenge error = %v", err)
	}
}

func TestWebAuthnCredentialIndexMismatchFailsClosed(t *testing.T) {
	srv := newTestServer(t)
	handle := make([]byte, 64)
	if _, err := srv.st.GetOrCreateWebAuthnUserHandle(handle); err != nil {
		t.Fatal(err)
	}
	credential := wa.Credential{ID: []byte("credential-id"), Authenticator: wa.Authenticator{SignCount: 1}}
	encoded, err := json.Marshal(credential)
	if err != nil {
		t.Fatal(err)
	}
	if err := srv.st.AddWebAuthnCredential(store.WebAuthnCredential{
		ID: base64.RawURLEncoding.EncodeToString(credential.ID), Name: "Corrupt key",
		CredentialData: encoded, SignCount: 2, Created: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := srv.webAuthnAdminUser(); err == nil {
		t.Fatal("inconsistent WebAuthn sign count was accepted")
	}
}

func testTLSState() *tls.ConnectionState {
	return &tls.ConnectionState{}
}

// Keep the tests independent of certificates: RequestIsSecure only checks
// whether TLS is non-nil.
var _ wa.User = webAuthnUser{}
