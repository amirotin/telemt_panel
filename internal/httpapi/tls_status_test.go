package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/amirotin/telemt_panel/internal/paneltls"
)

func TestPanelTLSStatusRequiresSession(t *testing.T) {
	s := newTestServer(t)
	h := s.Handler()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/settings/tls", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous status=%d", w.Code)
	}
	_, cookie := login(t, h, "admin", testPassword)
	if cookie == nil {
		t.Fatal("login failed")
	}
	r := httptest.NewRequest(http.MethodGet, "/api/settings/tls", nil)
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("authenticated status=%d", w.Code)
	}
	var data paneltls.Status
	if err := json.Unmarshal(w.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	if data.Mode != "http" || data.State != "http" || data.ExpiresAt != nil {
		t.Fatalf("status=%+v", data)
	}
}
