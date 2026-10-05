package httpapi

import (
	"errors"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/amirotin/telemt_panel/internal/store"
)

func TestLinkSettingsDefaultAndValidation(t *testing.T) {
	s := newTestServer(t)
	_, cookie := login(t, s.Handler(), "admin", testPassword)
	w := doRequest(t, s, cookie, "GET", "/api/settings/links", nil, nil)
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"allow_address_override":false}` {
		t.Fatal("default", w.Code, w.Body.String())
	}
	for _, body := range []string{`null`, `{}`, `{"allow_address_override":null}`, `{"allow_address_override":"true"}`, `{"allow_address_override":true,"host":"evil.example"}`, `{"allow_address_override":true} {}`} {
		w = doRequest(t, s, cookie, "PUT", "/api/settings/links", nil, []byte(body))
		if w.Code != 400 {
			t.Errorf("invalid body %s: %d", body, w.Code)
		}
	}
	for _, value := range []string{"true", "false"} {
		body := `{"allow_address_override":` + value + `}`
		w = doRequest(t, s, cookie, "PUT", "/api/settings/links", nil, []byte(body))
		if w.Code != 200 || strings.TrimSpace(w.Body.String()) != body {
			t.Fatal("save", w.Code, w.Body.String())
		}
		w = doRequest(t, s, cookie, "GET", "/api/settings/links", nil, nil)
		if w.Code != 200 || strings.TrimSpace(w.Body.String()) != body {
			t.Fatal("read", w.Code, w.Body.String())
		}
	}
}

func TestLinkSettingsPersistInLocalState(t *testing.T) {
	s := newTestServer(t)
	path := filepath.Join(t.TempDir(), "panel-state.json")
	state, err := store.NewState(path)
	if err != nil {
		t.Fatal(err)
	}
	replaceTestServerStore(s, state)
	_, cookie := login(t, s.Handler(), "admin", testPassword)
	w := doRequest(t, s, cookie, "PUT", "/api/settings/links", nil, []byte(`{"allow_address_override":true}`))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if err := state.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := store.NewState(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	replaceTestServerStore(s, reopened)
	w = doRequest(t, s, cookie, "GET", "/api/settings/links", nil, nil)
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"allow_address_override":true}` {
		t.Fatal(w.Code, w.Body.String())
	}
	entries, err := reopened.ListAudit(0)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, entry := range entries {
		if entry.Action == "links.settings_change" && entry.Target == "panel" {
			found = true
		}
	}
	if !found {
		t.Fatal("missing panel settings audit")
	}
}

type failingLinkSettingStore struct{ store.Store }

func (f failingLinkSettingStore) SetSetting(string, string) error { return errors.New("disk full") }

func TestLinkSettingsFailedSaveDoesNotEnableOverride(t *testing.T) {
	s := newTestServer(t)
	_, cookie := login(t, s.Handler(), "admin", testPassword)
	s.st = failingLinkSettingStore{s.st}
	w := doRequest(t, s, cookie, "PUT", "/api/settings/links", nil, []byte(`{"allow_address_override":true}`))
	if w.Code != 500 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = doRequest(t, s, cookie, "GET", "/api/settings/links", nil, nil)
	if strings.TrimSpace(w.Body.String()) != `{"allow_address_override":false}` {
		t.Fatal(w.Body.String())
	}
}

func TestLinkSettingsRequireAuthenticationAndCSRF(t *testing.T) {
	s := newTestServer(t)
	for _, method := range []string{"GET", "PUT"} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(method, "/api/settings/links", nil)
		r.Header.Set("Sec-Fetch-Site", "same-origin")
		s.Handler().ServeHTTP(w, r)
		if w.Code != 401 {
			t.Errorf("%s unauthenticated: %d", method, w.Code)
		}
	}
	_, cookie := login(t, s.Handler(), "admin", testPassword)
	w := doRequest(t, s, cookie, "PUT", "/api/settings/links", map[string]string{"Sec-Fetch-Site": "cross-site", "Origin": "https://attacker.example"}, []byte(`{"allow_address_override":true}`))
	if w.Code != 403 {
		t.Fatal("cross-site write", w.Code)
	}
}
