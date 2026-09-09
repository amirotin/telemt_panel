package hub

import (
	"bytes"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

func TestLargeUsersShareFullPollAndReplayExactCounterChange(t *testing.T) {
	f, client := newFakeTelemt(t)
	users := make([]telemt.UserInfo, 2000)
	for i := range users {
		users[i] = telemt.UserInfo{
			Username: fmt.Sprintf("scale-%04d", i), Enabled: true, InRuntime: true,
			TotalOctets:  uint64(9_007_199_254_740_992 + i),
			ActiveIPList: []string{fmt.Sprintf("192.0.%d.%d", i/256, i%256), fmt.Sprintf("2001:db8::%x", i+1)},
			Links:        telemt.UserLinks{Classic: []string{"tg://proxy?server=198.51.100.1&port=443&secret=fixture"}},
		}
	}
	f.setUsers(users)
	h := New(Config{UsersInterval: time.Hour, Grace: time.Hour}, client, nil)
	t.Cleanup(h.Close)
	state := h.topics["users"]
	// Drive complete cycles explicitly, using the same manual-poller fixture
	// as the full/minimal source-count tests; no wall-clock polling race.
	state.running = true
	state.stop = make(chan struct{})
	channels := make([]<-chan Event, 3)
	for i := range channels {
		ch, _, cancel, err := h.Subscribe([]string{"users"})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(cancel)
		channels[i] = ch
	}
	assertOneUsersRequest := func() {
		t.Helper()
		count := 0
		for len(f.requests) > 0 {
			if <-f.requests == "/v1/users" {
				count++
			}
		}
		if count != 1 {
			t.Fatalf("full cycle fetched users %d times for three subscribers", count)
		}
	}
	if !h.pollPeriodic(state) {
		t.Fatal("initial full cycle failed")
	}
	assertOneUsersRequest()
	first := recvEvent(t, channels[0], time.Second)
	var snapshot usersSnapshot
	if err := json.Unmarshal(first.Data, &snapshot); err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Users) != 2000 || len(snapshot.Users[1999].ActiveIPList) != 2 || len(snapshot.Users[1999].Links.Classic) != 1 {
		t.Fatal("large full snapshot lost users or rich fields")
	}
	for _, ch := range channels[1:] {
		if event := recvEvent(t, ch, time.Second); event.Seq != first.Seq || !bytes.Equal(event.Data, first.Data) {
			t.Fatal("subscribers did not share a coherent snapshot")
		}
	}
	if !h.pollPeriodic(state) {
		t.Fatal("unchanged full cycle failed")
	}
	assertOneUsersRequest()
	for _, ch := range channels {
		if len(ch) != 0 {
			t.Fatal("unchanged users produced another event")
		}
	}
	users[1999].TotalOctets++
	f.setUsers(users)
	if !h.pollPeriodic(state) {
		t.Fatal("changed full cycle failed")
	}
	assertOneUsersRequest()
	second := recvEvent(t, channels[0], time.Second)
	if err := json.Unmarshal(second.Data, &snapshot); err != nil {
		t.Fatal(err)
	}
	if got := snapshot.Users[1999].TotalOctets; got != users[1999].TotalOctets {
		t.Fatalf("adjacent uint64 change lost: got %d, want %d", got, users[1999].TotalOctets)
	}
	for _, ch := range channels[1:] {
		if event := recvEvent(t, ch, time.Second); event.Seq != second.Seq || !bytes.Equal(event.Data, second.Data) {
			t.Fatal("subscribers received different counter updates")
		}
	}
	replay, ok := h.ReplaySince(first.Seq, []string{"users"})
	if !ok || len(replay) != 1 || replay[0].Seq != second.Seq || !bytes.Equal(replay[0].Data, second.Data) {
		t.Fatal("reconnect replay did not preserve the exact changed snapshot")
	}
	t.Logf("2000 users: full payload=%d bytes, three subscribers share one users request per cycle", len(second.Data))
}
