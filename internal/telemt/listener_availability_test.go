package telemt

import (
	"encoding/json"
	"testing"
)

func TestMTProtoListenerState(t *testing.T) {
	for _, tc := range []struct {
		name, server, want string
	}{
		{"web only", `{"listeners":[{"transport":"web"},{"transport":"web"}]}`, "absent"},
		{"mixed", `{"listeners":[{"transport":"web"},{"transport":"mtproxy"}]}`, "configured"},
		{"default transport", `{"listeners":[{"ip":"0.0.0.0","port":443}]}`, "configured"},
		{"empty transport", `{"listeners":[{"transport":""}]}`, "unknown"},
		{"legacy port", `{"port":443}`, "configured"},
		{"legacy max port", `{"port":65535}`, "configured"},
		{"legacy zero port", `{"port":0}`, "unknown"},
		{"legacy invalid port", `{"port":65536}`, "unknown"},
		{"legacy string port", `{"port":"443"}`, "unknown"},
		{"legacy fractional port", `{"port":443.5}`, "unknown"},
		{"empty server", `{}`, "unknown"},
		{"null server", `null`, "unknown"},
		{"malformed server", `{`, "unknown"},
		{"array server", `[]`, "unknown"},
		{"empty listeners", `{"listeners":[]}`, "unknown"},
		{"null listeners", `{"listeners":null,"port":443}`, "unknown"},
		{"object listeners", `{"listeners":{}}`, "unknown"},
		{"null listener", `{"listeners":[null]}`, "unknown"},
		{"scalar listener", `{"listeners":[1]}`, "unknown"},
		{"unknown transport", `{"listeners":[{"transport":"future"}]}`, "unknown"},
		{"partial web information", `{"listeners":[{"transport":"web"},{"transport":"future"}]}`, "unknown"},
		{"null transport", `{"listeners":[{"transport":null}]}`, "unknown"},
		{"invalid transport", `{"listeners":[{"transport":false}]}`, "unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sections := map[string]json.RawMessage{"server": json.RawMessage(tc.server)}
			if got := MTProtoListenerState(sections); got != tc.want {
				t.Fatalf("MTProtoListenerState(%s) = %q, want %q", tc.server, got, tc.want)
			}
		})
	}
	t.Run("missing server despite web profile", func(t *testing.T) {
		sections := map[string]json.RawMessage{"web": json.RawMessage(`{"enabled":true,"vhosts":[{"profiles":[{"user":"alice"}]}]}`)}
		if got := MTProtoListenerState(sections); got != "unknown" {
			t.Fatalf("MTProtoListenerState = %q, want unknown", got)
		}
	})
}
