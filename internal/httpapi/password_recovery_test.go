package httpapi

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/store"
)

func TestPasswordRecoveryLoginAndPasskeyRemoval(t *testing.T) {
	srv := newTestServer(t)
	path := filepath.Join(t.TempDir(), "panel-state.json")
	state, err := store.NewState(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := state.BindPasswordAuth(srv.cfg.Auth.Username, srv.cfg.Auth.PasswordHash); err != nil {
		t.Fatal(err)
	}
	if _, err := state.GetOrCreateWebAuthnUserHandle(bytes.Repeat([]byte{1}, 64)); err != nil {
		t.Fatal(err)
	}
	if err := state.AddWebAuthnCredential(store.WebAuthnCredential{
		ID: "aWQ", Name: "Lost phone", CredentialData: []byte(`{}`), Created: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	srv.st = state
	w, oldCookie := login(t, srv.Handler(), "admin", testPassword)
	if w.Code != http.StatusNoContent || oldCookie == nil {
		t.Fatalf("initial login: %d", w.Code)
	}
	if err := state.Close(); err != nil {
		t.Fatal(err)
	}

	const recoveredPassword = "recovered-local-password"
	hash, err := auth.HashPassword(recoveredPassword)
	if err != nil {
		t.Fatal(err)
	}
	srv.cfg.Auth.PasswordHash = hash
	reopened, err := store.NewState(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if err := reopened.BindPasswordAuth(srv.cfg.Auth.Username, hash); err != nil {
		t.Fatal(err)
	}
	srv.st = reopened
	handler := srv.Handler()
	r := httptest.NewRequest("GET", "/api/auth/me", nil)
	r.AddCookie(oldCookie)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("old cookie accepted: %d", w.Code)
	}
	if w, _ := login(t, handler, "admin", testPassword); w.Code != http.StatusUnauthorized {
		t.Fatalf("old password accepted: %d", w.Code)
	}
	w, cookie := login(t, handler, "admin", recoveredPassword)
	if w.Code != http.StatusNoContent || cookie == nil {
		t.Fatalf("recovered password rejected: %d", w.Code)
	}
	if keys, err := reopened.ListWebAuthnCredentials(); err != nil || len(keys) != 1 {
		t.Fatalf("passkeys not preserved: %d, %v", len(keys), err)
	}
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, mutating("DELETE", "/api/auth/webauthn/credentials/aWQ", cookie))
	if w.Code != http.StatusNoContent {
		t.Fatalf("cannot remove lost passkey after password login: %d", w.Code)
	}
}
