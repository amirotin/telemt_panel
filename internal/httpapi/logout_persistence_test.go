package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

func TestAuditLogoutReportsFailedDurableRevocation(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	st, err := store.NewState(filepath.Join(dir, "panel-state.json"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	const token = "audit-logout-token"
	now := time.Now()
	if err := st.PutSession(store.Session{IDHash: auth.HashToken(token), Created: now, LastSeen: now}); err != nil {
		t.Fatal(err)
	}
	tc := telemt.New("http://127.0.0.1:1", "")
	hb := hub.New(hub.Config{}, tc, st)
	defer hb.Close()
	cfg := &config.Config{Auth: config.AuthConfig{Username: "admin", PasswordHash: testPasswordHash}, Privileges: config.PrivilegesConfig{Mode: "manual"}}
	srv := New(cfg, tc, st, hb, "audit")
	defer srv.limiter.Stop()
	defer srv.subLimiter.Stop()
	// Make only this temporary fixture's state path unwritable deterministically,
	// including when tests run as root. This exercises actual persistence rollback.
	if err := os.Rename(dir, dir+".saved"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dir, nil, 0600); err != nil {
		t.Fatal(err)
	}
	cookie := &http.Cookie{Name: auth.CookieName, Value: token}
	logout := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	logout.Header.Set("Sec-Fetch-Site", "same-origin")
	logout.AddCookie(cookie)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, logout)
	for _, value := range w.Result().Cookies() {
		if value.Name == auth.CookieName && value.MaxAge < 0 {
			t.Fatal("failed durable revoke cleared the retry cookie")
		}
	}
	check := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	check.AddCookie(cookie)
	me := httptest.NewRecorder()
	srv.Handler().ServeHTTP(me, check)
	if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), "session_revoke_failed") || me.Code != http.StatusOK {
		t.Fatalf("logout reported success status=%d but original token still authenticates status=%d after durable revocation failed", w.Code, me.Code)
	}
}
