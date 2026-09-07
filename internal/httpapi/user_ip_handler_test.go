package httpapi

import (
	"encoding/json"
	"github.com/amirotin/telemt_panel/internal/store"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestUserIPHistoryEndpoint(t *testing.T) {
	s, m := newStorageTestServer(t)
	now := time.Now().Unix()
	if err := m.ApplyUserIPBatch(store.UserIPBatch{ID: "one", Through: now, Records: []store.UserIPRecord{
		{Username: "alice", IP: "192.0.2.1", Family: 4, First: now - 100, Last: now, Observations: 2, Source: 1},
		{Username: "alice", IP: "2001:db8::1", Family: 6, First: now - 50, Last: now - 10, Observations: 1, Source: 2},
	}}); err != nil {
		t.Fatal(err)
	}
	get := func(query string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "/api/users/alice/ip-history"+query, nil)
		r.SetPathValue("username", "alice")
		w := httptest.NewRecorder()
		s.handleGetUserIPHistory(w, r)
		return w
	}
	w := get("?limit=1")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var page userIPHistoryView
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Total != 2 || len(page.Items) != 1 || page.NextCursor == "" || page.Items[0].ActiveNow != nil {
		t.Fatalf("page: %+v", page)
	}
	w = get("?limit=1&cursor=" + page.NextCursor)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var next userIPHistoryView
	_ = json.Unmarshal(w.Body.Bytes(), &next)
	if len(next.Items) != 1 || next.Items[0].IP != "2001:db8::1" || next.NextCursor != "" {
		t.Fatalf("next: %+v", next)
	}
	for _, query := range []string{"?range=no", "?limit=0", "?family=5", "?family=6&cursor=" + page.NextCursor, "?cursor=invalid"} {
		if w := get(query); w.Code != 400 {
			t.Errorf("%s: %d", query, w.Code)
		}
	}
	w = get("?q=%25")
	_ = json.Unmarshal(w.Body.Bytes(), &next)
	if next.Matched != 0 {
		t.Fatal("search interpreted wildcard")
	}
}

func TestUserIPResetRequiresConfirmation(t *testing.T) {
	s, m := newStorageTestServer(t)
	now := time.Now().Unix()
	if err := m.ApplyUserIPBatch(store.UserIPBatch{ID: "seed", Through: now, Records: []store.UserIPRecord{{Username: "alice", IP: "192.0.2.1", Family: 4, First: now, Last: now, Observations: 1, Source: 1}}}); err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{`{}`, `{"confirm":false}`, `{"confirm":true,"unexpected":1}`} {
		r := httptest.NewRequest("POST", "/api/users/alice/ip-history/reset", strings.NewReader(body))
		r.SetPathValue("username", "alice")
		w := httptest.NewRecorder()
		s.handleResetUserIPHistory(w, r)
		if w.Code != 400 {
			t.Fatalf("unconfirmed reset %s: %d", body, w.Code)
		}
	}
	page, _ := m.UserIPHistory(store.UserIPQuery{Username: "alice", Now: now, Limit: 50})
	if page.Total != 1 {
		t.Fatal("unconfirmed reset deleted history")
	}
	r := httptest.NewRequest("POST", "/api/users/alice/ip-history/reset", strings.NewReader(`{"confirm":true}`))
	r.SetPathValue("username", "alice")
	w := httptest.NewRecorder()
	s.handleResetUserIPHistory(w, r)
	if w.Code != 204 {
		t.Fatalf("confirmed reset: %d %s", w.Code, w.Body.String())
	}
	page, _ = m.UserIPHistory(store.UserIPQuery{Username: "alice", Now: now, Limit: 50})
	if page.Total != 0 {
		t.Fatal("reset retained rows")
	}
}
