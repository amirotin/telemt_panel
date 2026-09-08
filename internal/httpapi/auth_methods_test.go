package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPasswordLoginDoesNotRequireSecondFactor(t *testing.T) {
	srv := newTestServer(t)
	handler := srv.Handler()
	w, cookie := login(t, handler, "admin", testPassword)
	if w.Code != http.StatusNoContent || cookie == nil {
		t.Fatalf("password login = %d", w.Code)
	}
	r := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	var me map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &me); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusOK || len(me) != 2 || me["username"] == nil || me["passkeys"] == nil {
		t.Fatalf("unexpected auth identity: %d %s", w.Code, w.Body.String())
	}
}

func TestRemovedSecondFactorRoutesReturnJSONNotFound(t *testing.T) {
	srv := newTestServer(t)
	handler := srv.Handler()
	_, cookie := login(t, handler, "admin", testPassword)
	if cookie == nil {
		t.Fatal("password login failed")
	}
	for _, route := range []struct{ method, path string }{
		{http.MethodPost, "/api/auth/totp/setup"},
		{http.MethodPost, "/api/auth/totp/enable"},
		{http.MethodDelete, "/api/auth/totp"},
	} {
		t.Run(route.path, func(t *testing.T) {
			for _, session := range []*http.Cookie{nil, cookie} {
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, mutating(route.method, route.path, session))
				var body struct {
					Code string `json:"code"`
				}
				if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
					t.Fatal(err)
				}
				if w.Code != http.StatusNotFound || body.Code != "not_found" {
					t.Fatalf("removed endpoint: %d %s", w.Code, w.Body.String())
				}
			}
		})
	}
}
