package httpapi

import (
	"bytes"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/store"
	wa "github.com/go-webauthn/webauthn/webauthn"
)

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
