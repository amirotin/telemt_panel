package telemt

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

func TestDiscoveryCapabilitiesRecoverWithoutMutationProbes(t *testing.T) {
	var transient atomic.Bool
	transient.Store(true)
	var schemaReads atomic.Int32
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Errorf("mutation probe: %s", r.Method)
		}
		switch r.URL.Path {
		case "/v1/capabilities":
			if transient.Load() {
				w.WriteHeader(503)
				return
			}
			fmt.Fprint(w, `{"ok":true,"data":{"read_only":true,"operations":[`+
				`{"id":"config_schema","method":"GET","path":"/v1/config/schema","supported":true,"enabled":true},`+
				`{"id":"config_state","method":"GET","path":"/v1/config/state","supported":true,"enabled":true},`+
				`{"id":"config_validate","method":"POST","path":"/v1/config/validate","supported":true,"enabled":true,"read_only_operation":true},`+
				`{"id":"access_policy_get","method":"GET","path":"/v1/access/policy","supported":true,"enabled":true},`+
				`{"id":"access_policy_patch","method":"PATCH","path":"/v1/access/policy","supported":true,"enabled":true,"mutable":false}]}}`)
		case "/v1/config/schema":
			schemaReads.Add(1)
			fmt.Fprint(w, `{"ok":true,"data":{"schema_version":1,"fields":[{"path":"access.user_source_deny","sensitivity":"credential","api":{"request_field":"source_deny","write_routes":["POST /v1/users","PATCH /v1/users/{username}"]}}]}}`)
		default:
			http.NotFound(w, r)
		}
	})
	for i := 0; i < 3; i++ {
		caps, err := c.Capabilities(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(caps)
		var values map[string]bool
		json.Unmarshal(raw, &values)
		if i > 0 {
			for _, name := range []string{"config_schema", "config_state", "config_validation", "access_policy", "user_source_deny", "read_only"} {
				if !values[name] {
					t.Errorf("%s missing after transient failure: %s", name, raw)
				}
			}
		}
		transient.Store(false)
	}
	if n := schemaReads.Load(); n != 1 {
		t.Errorf("schema reads=%d want 1", n)
	}
}

func TestDiscoveryLegacyFallbackAndVersionUpgrade(t *testing.T) {
	for _, status := range []int{404, 405, 401} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			now := time.Date(2026, 11, 11, 0, 0, 0, 0, time.UTC)
			upgraded := false
			c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v1/capabilities":
					if !upgraded {
						w.WriteHeader(status)
						return
					}
					fmt.Fprint(w, `{"ok":true,"data":{"operations":[{"method":"GET","path":"/v1/config/state","supported":true,"enabled":true}]}}`)
				case "/v1/config/schema":
					if !upgraded {
						w.WriteHeader(404)
						return
					}
					fmt.Fprint(w, `{"ok":true,"data":{"fields":[]}}`)
				case "/v1/system/info":
					version := "3.5.16"
					if upgraded {
						version = "3.5.17"
					}
					fmt.Fprintf(w, `{"version":%q}`, version)
				default:
					http.NotFound(w, r)
				}
			})
			c.now = func() time.Time { return now }
			c.SystemInfo(context.Background())
			caps, _ := c.Capabilities(context.Background())
			raw, _ := json.Marshal(caps)
			var values map[string]bool
			json.Unmarshal(raw, &values)
			if values["config_state"] {
				t.Errorf("legacy claimed new capability: %s", raw)
			}
			upgraded = true
			c.SystemInfo(context.Background())
			caps, _ = c.Capabilities(context.Background())
			raw, _ = json.Marshal(caps)
			json.Unmarshal(raw, &values)
			if !values["config_state"] {
				t.Errorf("upgrade did not recover: %s", raw)
			}
		})
	}
}
