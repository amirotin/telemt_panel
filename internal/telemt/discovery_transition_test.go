package telemt

import (
	"context"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

func TestDiscoveryDowngradeAndUpgradeDiscardCachedSupport(t *testing.T) {
	var modern atomic.Bool
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("capability discovery attempted mutation %s", r.Method)
		}
		switch r.URL.Path {
		case "/v1/system/info":
			version := "3.5.5"
			if modern.Load() {
				version = "3.5.17"
			}
			fmt.Fprintf(w, `{"version":%q}`, version)
		case "/v1/capabilities":
			if !modern.Load() {
				http.NotFound(w, r)
				return
			}
			fmt.Fprint(w, `{"ok":true,"data":{"operations":[{"method":"GET","path":"/v1/config/state","supported":true,"enabled":true}],"api_version":"v1","schema_version":1,"software_version":"3.5.17","config_schema":"/v1/config/schema","read_only":false,"availability_scope":"feature_and_runtime_source_prerequisites_not_request_success"}}`)
		default:
			http.NotFound(w, r)
		}
	})
	// Keep the clock fixed so every transition must invalidate the live cache.
	c.now = func() time.Time { return time.Date(2026, 11, 11, 0, 0, 0, 0, time.UTC) }
	for _, supported := range []bool{true, false, true} {
		modern.Store(supported)
		if _, err := c.SystemInfo(context.Background()); err != nil {
			t.Fatal(err)
		}
		caps, err := c.Capabilities(context.Background())
		if err != nil || caps.ConfigState != supported {
			t.Fatalf("native support=%v: capabilities=%+v, error=%v", supported, caps, err)
		}
	}
}
