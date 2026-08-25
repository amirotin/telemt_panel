package hub

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

// TestUsersTopicNullVsEmptyArrayDoesNotDoubleBroadcast covers mini-task
// 2c's requirement that normalizeSlices (internal/telemt/normalize.go)
// runs strictly before diffKey ever sees a payload: the SDK's decode step
// already turns a null/omitted array into `[]`, so two Telemt responses
// that differ only in which of those two wire forms they use for the same
// logical (empty) list must decode to byte-identical normalized JSON and
// must not cause a second SSE broadcast.
func TestUsersTopicNullVsEmptyArrayDoesNotDoubleBroadcast(t *testing.T) {
	const bodyWithNullArrays = `{"ok":true,"data":[{"username":"alice","enabled":true,"in_runtime":true,
		"current_connections":0,"active_unique_ips":0,"active_unique_ips_list":null,
		"recent_unique_ips":0,"recent_unique_ips_list":null,"total_octets":0,
		"links":{"classic":[],"secure":[],"tls":[],"tls_domains":[]}}],"revision":"r"}`

	var mu sync.Mutex
	body := bodyWithNullArrays

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/users":
			mu.Lock()
			b := body
			mu.Unlock()
			w.Write([]byte(b))
		default:
			// /v1/stats/users/quota and anything else: capability absent,
			// same as an old Telemt build — irrelevant to this test.
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	tc := telemt.New(srv.URL, "")

	interval := 10 * time.Millisecond
	h := New(Config{UsersInterval: interval, StatsInterval: time.Hour, Grace: time.Second}, tc, nil)
	t.Cleanup(h.Close)

	ch, _, cancel, err := h.Subscribe([]string{"users"})
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer cancel()

	first := recvEvent(t, ch, 2*time.Second)
	snap := decodeUsersSnapshot(t, first.Data)
	if len(snap.Users) != 1 {
		t.Fatalf("users = %+v, want 1", snap.Users)
	}
	// Sanity check on the normalization itself: the cached/broadcast
	// payload already shows [] rather than null despite the wire response
	// using null — proving normalization ran before this ever reached the
	// hub's cache, not just before diffKey specifically.
	if !strings.Contains(string(first.Data), `"active_unique_ips_list":[]`) {
		t.Fatalf("first event data = %s, want active_unique_ips_list serialized as [] not null", first.Data)
	}

	// Swap in the logically-identical, differently-spelled response: same
	// user, same everything, only null -> [] for the two list fields.
	mu.Lock()
	body = strings.NewReplacer(
		`"active_unique_ips_list":null`, `"active_unique_ips_list":[]`,
		`"recent_unique_ips_list":null`, `"recent_unique_ips_list":[]`,
	).Replace(bodyWithNullArrays)
	mu.Unlock()

	// Several poll intervals pass with the "changed" (but only at the raw
	// wire level) response: no second broadcast, since both forms
	// normalize to the exact same JSON before diffKey ever compares them.
	assertNoBroadcast(t, ch, 10*interval)
}
