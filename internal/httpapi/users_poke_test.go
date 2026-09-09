package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
	"github.com/amirotin/telemt_panel/internal/userprojection"
)

// pokeUsersSnapshot mirrors just the field this file's tests need from the
// "users" topic's composite payload (hub.go's usersSnapshot) — duplicated
// rather than exported, matching hub_test.go's own decodeUsersSnapshot
// pattern in the other direction.
type pokeUsersSnapshot struct {
	Users []userprojection.User `json:"users"`
}

func decodePokeUsersSnapshot(t *testing.T, data json.RawMessage) []userprojection.User {
	t.Helper()
	var snap pokeUsersSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		t.Fatalf("decode users snapshot: %v (data=%s)", err, data)
	}
	return snap.Users
}

func hasUsername(users []userprojection.User, name string) bool {
	for _, u := range users {
		if u.Username == name {
			return true
		}
	}
	return false
}

func seedPokeUserTraffic(t *testing.T, st store.Store, usernames ...string) {
	t.Helper()
	for index, raw := range []uint64{10, 110} {
		users := make([]store.UserTrafficObservation, len(usernames))
		for i, username := range usernames {
			users[i] = store.UserTrafficObservation{Username: username, RawOctets: raw}
		}
		if _, err := st.ApplyUserTrafficSnapshot(store.UserTrafficSnapshot{
			ObservedAt:       int64(1_700_000_000 + index),
			SourceStartedAt:  1_699_999_000,
			TelemetryEnabled: true,
			Users:            users,
		}); err != nil {
			t.Fatalf("seed user traffic: %v", err)
		}
	}
}

func trafficForUsername(t *testing.T, data json.RawMessage, username string) *userprojection.Traffic {
	t.Helper()
	for _, user := range decodePokeUsersSnapshot(t, data) {
		if user.Username == username {
			return user.Traffic
		}
	}
	t.Fatalf("users snapshot = %s, want %s", data, username)
	return nil
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

// afterInitialIPObservation makes an accidental new observation distinguishable
// from the initial periodic poll, even with second-resolution timestamps.
func afterInitialIPObservation(t *testing.T, srv *Server) int64 {
	t.Helper()
	observedAt := srv.hub.UserIPSourceStatus().LastSuccess
	if observedAt == 0 {
		t.Fatal("initial periodic users poll did not record an IP observation")
	}
	time.Sleep(time.Until(time.Unix(observedAt+1, 0)))
	return observedAt
}

func TestTrafficResets_PokeUsersTopicWithoutNewSourceObservation(t *testing.T) {
	t.Run("individual", func(t *testing.T) {
		fake := newFakeTelemt(aliceFixture(), bobFixture())
		srv, cookie := newUsersTestServer(t, fake, false)
		seedPokeUserTraffic(t, srv.st, "alice", "bob")
		ch := subscribeUsersDrainInitial(t, srv)
		observedAt := afterInitialIPObservation(t, srv)

		r := mutatingJSON(t, "POST", "/api/users/alice/traffic/reset", cookie, map[string]any{"confirm": true})
		w := httptest.NewRecorder()
		srv.Handler().ServeHTTP(w, r)
		if w.Code != 204 {
			t.Fatalf("reset status = %d: %s", w.Code, w.Body)
		}

		ev := recvEventOrFail(t, ch)
		if traffic := trafficForUsername(t, ev.Data, "alice"); traffic != nil {
			t.Fatalf("alice traffic after reset = %+v, want nil", traffic)
		}
		if traffic := trafficForUsername(t, ev.Data, "bob"); traffic == nil || traffic.ObservedTotalBytes != 100 {
			t.Fatalf("bob traffic after alice reset = %+v, want 100 bytes", traffic)
		}
		if status := srv.hub.UserIPSourceStatus(); status.LastSuccess != observedAt || status.Pending {
			t.Fatalf("traffic reset recorded an IP observation: %+v", status)
		}
	})

	t.Run("global", func(t *testing.T) {
		fake := newFakeTelemt(aliceFixture(), bobFixture())
		srv, cookie := newUsersTestServer(t, fake, false)
		seedPokeUserTraffic(t, srv.st, "alice", "bob")
		ch := subscribeUsersDrainInitial(t, srv)
		observedAt := afterInitialIPObservation(t, srv)

		r := mutatingJSON(t, "POST", "/api/traffic/reset", cookie, map[string]any{"confirm": true})
		w := httptest.NewRecorder()
		srv.Handler().ServeHTTP(w, r)
		if w.Code != 204 {
			t.Fatalf("reset status = %d: %s", w.Code, w.Body)
		}

		ev := recvEventOrFail(t, ch)
		for _, username := range []string{"alice", "bob"} {
			if traffic := trafficForUsername(t, ev.Data, username); traffic != nil {
				t.Fatalf("%s traffic after reset = %+v, want nil", username, traffic)
			}
		}
		if status := srv.hub.UserIPSourceStatus(); status.LastSuccess != observedAt || status.Pending {
			t.Fatalf("traffic reset recorded an IP observation: %+v", status)
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
