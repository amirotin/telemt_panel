package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
)

// getAudit calls handleGetAudit directly (bypassing the session/CSRF
// middleware chain, which isn't this handler's concern) with the given raw
// query string, so these tests can control the store's audit ring
// precisely without login()'s own "login" audit entry getting in the way
// of exact ordering/cursor assertions.
func getAudit(t *testing.T, srv *Server, rawQuery string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest("GET", "/api/audit?"+rawQuery, nil)
	w := httptest.NewRecorder()
	srv.handleGetAudit(w, r)
	return w
}

// TestHandleGetAudit_NewestFirst covers ordering: entries come back
// newest-first, matching store.ListAudit's own contract.
func TestHandleGetAudit_NewestFirst(t *testing.T) {
	srv := newTestServer(t)
	base := time.Now()
	for i, action := range []string{"first", "second", "third"} {
		if err := srv.st.AppendAudit(store.AuditEntry{TS: base.Add(time.Duration(i) * time.Minute), Action: action}); err != nil {
			t.Fatal(err)
		}
	}

	w := getAudit(t, srv, "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	var got []auditEntryView
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("entries = %d, want 3", len(got))
	}
	if got[0].Action != "third" || got[1].Action != "second" || got[2].Action != "first" {
		t.Errorf("order = %v, want [third, second, first]", []string{got[0].Action, got[1].Action, got[2].Action})
	}
}

// TestHandleGetAudit_Limit covers the limit query parameter.
func TestHandleGetAudit_Limit(t *testing.T) {
	srv := newTestServer(t)
	for i := 0; i < 5; i++ {
		if err := srv.st.AppendAudit(store.AuditEntry{TS: time.Now(), Action: "a"}); err != nil {
			t.Fatal(err)
		}
	}

	w := getAudit(t, srv, "limit=2")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	var got []auditEntryView
	json.Unmarshal(w.Body.Bytes(), &got)
	if len(got) != 2 {
		t.Fatalf("entries = %d, want 2", len(got))
	}
}

// TestHandleGetAudit_BeforeCursor covers the before= cursor: it must page
// strictly older than the given ts, and the cursor value round-trips
// through the same RFC3339Nano format encoding/json produces for a prior
// response's ts field.
func TestHandleGetAudit_BeforeCursor(t *testing.T) {
	srv := newTestServer(t)
	base := time.Now()
	var middleTS time.Time
	for i, action := range []string{"oldest", "middle", "newest"} {
		ts := base.Add(time.Duration(i) * time.Minute)
		if action == "middle" {
			middleTS = ts
		}
		if err := srv.st.AppendAudit(store.AuditEntry{TS: ts, Action: action}); err != nil {
			t.Fatal(err)
		}
	}

	cursor := url.QueryEscape(middleTS.Format(time.RFC3339Nano))
	w := getAudit(t, srv, "before="+cursor)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	var got []auditEntryView
	json.Unmarshal(w.Body.Bytes(), &got)
	if len(got) != 1 || got[0].Action != "oldest" {
		t.Errorf("entries = %+v, want just [oldest]", got)
	}
}

func TestHandleGetAudit_BadLimit(t *testing.T) {
	srv := newTestServer(t)
	w := getAudit(t, srv, "limit=not-a-number")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", w.Code, w.Body)
	}
}

func TestHandleGetAudit_BadBeforeCursor(t *testing.T) {
	srv := newTestServer(t)
	w := getAudit(t, srv, "before=not-a-timestamp")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", w.Code, w.Body)
	}
}

// TestHandleGetAudit_EmptyIsNotAnError covers the no-entries-yet case: 200
// with an empty array.
func TestHandleGetAudit_EmptyIsNotAnError(t *testing.T) {
	srv := newTestServer(t)
	w := getAudit(t, srv, "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	var got []auditEntryView
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("entries = %v, want empty", got)
	}
}

func TestAuditEntryView_EnrichedAndLegacyFields(t *testing.T) {
	srv := newTestServer(t)
	ts := time.Date(2026, 9, 1, 12, 0, 0, 123, time.UTC)

	rich := srv.toAuditEntryView(store.AuditEntry{
		TS:      ts,
		ID:      "audit_rich",
		Action:  "user.enabled",
		Actor:   "admin",
		Target:  "alice",
		Outcome: "success",
		IP:      "198.51.100.4",
		Subject: "alice",
		Detail:  "enabled=true",
	})
	if rich.ID != "audit_rich" || rich.Actor != "admin" || rich.Target != "alice" || rich.Outcome != "success" || rich.IP != "198.51.100.4" {
		t.Fatalf("rich view = %+v", rich)
	}
	if rich.Metadata["enabled"] != "true" {
		t.Fatalf("metadata = %v, want enabled=true", rich.Metadata)
	}

	legacy := srv.toAuditEntryView(store.AuditEntry{
		TS:      ts,
		Action:  "user.create",
		Subject: "bob",
	})
	if legacy.ID == "" || legacy.Actor != srv.cfg.Auth.Username || legacy.Target != "bob" || legacy.Outcome != "success" {
		t.Fatalf("legacy fallback view = %+v", legacy)
	}
}

// TestHandleGetAudit_RequiresSession covers auth via the full router (the
// one case in this file that needs the middleware chain, unlike the
// content assertions above).
func TestHandleGetAudit_RequiresSession(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()

	r := httptest.NewRequest("GET", "/api/audit", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}
