package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

// pokeUsersSnapshot mirrors just the field this file's tests need from the
// "users" topic's composite payload (hub.go's usersSnapshot) — duplicated
// rather than exported, matching hub_test.go's own decodeUsersSnapshot
// pattern in the other direction.
type pokeUsersSnapshot struct {
	Users []telemt.UserInfo `json:"users"`
}

func decodePokeUsersSnapshot(t *testing.T, data json.RawMessage) []telemt.UserInfo {
	t.Helper()
	var snap pokeUsersSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		t.Fatalf("decode users snapshot: %v (data=%s)", err, data)
	}
	return snap.Users
}

func hasUsername(users []telemt.UserInfo, name string) bool {
	for _, u := range users {
		if u.Username == name {
			return true
		}
	}
	return false
}

// TestUserMutations_PokeUsersTopicPromptly is the handler-level test the
// mini-task brief asks for: each of the six user-mutation endpoints must
// cause a live "users" SSE subscriber to observe the change well before
// the topic's normal poll interval would naturally catch up. newUsersTestServer
// builds its hub via hub.New(hub.Config{}, ...) — the real 10s production
// UsersInterval, not a test override — so an event arriving inside this
// test's 2s recv timeout can only be explained by Hub.PokeAfter, not the
// natural schedule.
func TestUserMutations_PokeUsersTopicPromptly(t *testing.T) {
	t.Run("create", func(t *testing.T) {
		fake := newFakeTelemt(bobFixture())
		srv, cookie := newUsersTestServer(t, fake, false)
		ch := subscribeUsersDrainInitial(t, srv)

		r := mutatingJSON(t, "POST", "/api/users", cookie, map[string]any{"username": "newbie"})
		w := httptest.NewRecorder()
		srv.Handler().ServeHTTP(w, r)
		if w.Code != 201 {
			t.Fatalf("create status = %d: %s", w.Code, w.Body)
		}

		ev := recvEventOrFail(t, ch)
		if !hasUsername(decodePokeUsersSnapshot(t, ev.Data), "newbie") {
			t.Fatalf("users snapshot after create = %s, want it to contain newbie", ev.Data)
		}
	})

	t.Run("patch", func(t *testing.T) {
		fake := newFakeTelemt(bobFixture())
		srv, cookie := newUsersTestServer(t, fake, false)
		ch := subscribeUsersDrainInitial(t, srv)

		// "secret" is the one patch field this package's fakeTelemt models
		// (handlePatchLocked) — it rewrites the user's classic link, which
		// is part of telemt.UserInfo and therefore visible in the "users"
		// topic's payload.
		newSecret := "22222222222222222222222222222222"[:32]
		r := mutatingJSON(t, "PATCH", "/api/users/bob", cookie, map[string]any{"secret": newSecret})
		w := httptest.NewRecorder()
		srv.Handler().ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("patch status = %d: %s", w.Code, w.Body)
		}

		ev := recvEventOrFail(t, ch)
		users := decodePokeUsersSnapshot(t, ev.Data)
		if len(users) != 1 || len(users[0].Links.Classic) != 1 || !bytes.Contains([]byte(users[0].Links.Classic[0]), []byte(newSecret)) {
			t.Fatalf("users snapshot after patch = %s, want bob's link updated with the new secret", ev.Data)
		}
	})

	t.Run("delete", func(t *testing.T) {
		fake := newFakeTelemt(aliceFixture(), bobFixture())
		srv, cookie := newUsersTestServer(t, fake, false)
		ch := subscribeUsersDrainInitial(t, srv)

		r := mutating("DELETE", "/api/users/bob", cookie)
		w := httptest.NewRecorder()
		srv.Handler().ServeHTTP(w, r)
		if w.Code != 204 {
			t.Fatalf("delete status = %d: %s", w.Code, w.Body)
		}

		ev := recvEventOrFail(t, ch)
		if hasUsername(decodePokeUsersSnapshot(t, ev.Data), "bob") {
			t.Fatalf("users snapshot after delete = %s, want bob removed", ev.Data)
		}
	})

	t.Run("reset-quota", func(t *testing.T) {
		fake := newFakeTelemt(bobFixture())
		fake.hasQuota = true
		fake.quota = map[string]telemt.QuotaEntry{"bob": {DataQuotaBytes: 1024, UsedBytes: 512}}
		srv, cookie := newUsersTestServer(t, fake, false)
		ch := subscribeUsersDrainInitial(t, srv)

		r := mutating("POST", "/api/users/bob/reset-quota", cookie)
		w := httptest.NewRecorder()
		srv.Handler().ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("reset-quota status = %d: %s", w.Code, w.Body)
		}

		// The users topic's poller was already running (subscribeUsersDrainInitial),
		// so the poke must produce at least one more event; presence is
		// enough here — quota-content assertions belong to the existing
		// REST-level tests for this handler.
		recvEventOrFail(t, ch)
	})

	t.Run("rotate-secret", func(t *testing.T) {
		fake := newFakeTelemt(bobFixture())
		srv, cookie := newUsersTestServer(t, fake, false)
		ch := subscribeUsersDrainInitial(t, srv)

		r := mutating("POST", "/api/users/bob/rotate-secret", cookie)
		w := httptest.NewRecorder()
		srv.Handler().ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("rotate-secret status = %d: %s", w.Code, w.Body)
		}

		recvEventOrFail(t, ch)
	})

	t.Run("set-enabled", func(t *testing.T) {
		fake := newFakeTelemt(bobFixture())
		srv, cookie := newUsersTestServer(t, fake, false)
		ch := subscribeUsersDrainInitial(t, srv)

		r := mutatingJSON(t, "PUT", "/api/users/bob/enabled", cookie, map[string]any{"enabled": false})
		w := httptest.NewRecorder()
		srv.Handler().ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("set-enabled status = %d: %s", w.Code, w.Body)
		}

		ev := recvEventOrFail(t, ch)
		users := decodePokeUsersSnapshot(t, ev.Data)
		if len(users) != 1 || users[0].Enabled {
			t.Fatalf("users snapshot after disable = %s, want bob disabled", ev.Data)
		}
	})
}

// subscribeUsersDrainInitial subscribes srv's hub to "users" directly
// (bypassing the SSE-over-HTTP wire format, which sse_test.go already
// covers) and waits for the immediate on-start poll's snapshot, so the
// mutation-triggered poke below is unambiguously the second event.
func subscribeUsersDrainInitial(t *testing.T, srv *Server) <-chan hub.Event {
	t.Helper()
	ch, _, cancel, err := srv.hub.Subscribe([]string{"users"})
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	t.Cleanup(cancel)
	recvEventOrFail(t, ch)
	return ch
}
