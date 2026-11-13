package hub

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

func TestUsersTopicPreservesOptionalPolicyMetadata(t *testing.T) {
	f, tc := newFakeTelemt(t)
	var user telemt.UserInfo
	if err := json.Unmarshal([]byte(`{"username":"alice","source_deny":[],"source_deny_status":{"effective":null,"runtime_reload_required":null,"apply_mode":"generation_reload","reload_endpoint":"POST /v1/system/reload","effective_scope":"request_generation_snapshot"},"limits":{"desired":{"max_tcp_conns":{"value":7,"configured_override":0,"global_value":7,"origin":"global_default"}},"effective":null}}`), &user); err != nil {
		t.Fatal(err)
	}
	f.setUsers([]telemt.UserInfo{user, {Username: "legacy"}})
	h := New(Config{UsersInterval: time.Hour, StatsInterval: time.Hour}, tc, nil)
	t.Cleanup(h.Close)
	ch, _, cancel, err := h.Subscribe([]string{"users"})
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	ev := <-ch
	if ev.Err != "" {
		t.Fatal(ev.Err)
	}
	var snapshot struct {
		Users []map[string]json.RawMessage `json:"users"`
	}
	if err := json.Unmarshal(ev.Data, &snapshot); err != nil {
		t.Fatal(err)
	}
	modern := snapshot.Users[0]
	if string(modern["source_deny"]) != "[]" || !strings.Contains(string(modern["source_deny_status"]), `"effective":null`) || !strings.Contains(string(modern["limits"]), `"configured_override":0`) {
		t.Fatalf("policy metadata lost: %s", ev.Data)
	}
	for _, key := range []string{"source_deny", "source_deny_status", "limits"} {
		if _, ok := snapshot.Users[1][key]; ok {
			t.Fatalf("legacy %s must be absent: %s", key, ev.Data)
		}
	}
}
