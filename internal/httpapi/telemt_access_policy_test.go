package httpapi

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

func TestAccessPolicyRevisionPrecisionAndPatchSemantics(t *testing.T) {
	var bodies []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/access/policy" {
			http.NotFound(w, r)
			return
		}
		if r.Method == "PATCH" {
			body, _ := io.ReadAll(r.Body)
			bodies = append(bodies, string(body))
			if r.Header.Get("If-Match") != "s1" || r.Header.Get("If-Runtime-Match") != "r1" {
				t.Errorf("lost preconditions")
			}
		}
		w.Write([]byte(`{"ok":true,"revision":"s2","data":{"desired":{"user_max_unique_ips_window_secs":9007199254740993,"cidr_rate_limits":{"192.0.2.0/24":{"up_bps":18446744073709551615,"down_bps":0}}},"effective":{},"runtime":{"runtime_match":"r2"},"published_match":false,"apply_mode":"watcher"}}`))
	}))
	defer upstream.Close()
	srv, cookie := newTelemtInfoTestServer(t, telemt.New(upstream.URL, ""))
	w := doRequest(t, srv, cookie, "GET", "/api/telemt/access-policy", nil, nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "18446744073709551615") || !strings.Contains(w.Body.String(), `"revision":"s2"`) {
		t.Fatalf("get: %d %s", w.Code, w.Body)
	}
	for _, body := range []string{`{"cidr_rate_limits":{"192.0.2.0/24":null,"*4/24":{"up_bps":9007199254740993}}}`, `{"cidr_rate_limits":null}`} {
		w := doRequest(t, srv, cookie, "PATCH", "/api/telemt/access-policy", map[string]string{"If-Match": "s1", "If-Runtime-Match": "r1"}, []byte(body))
		if w.Code != 200 {
			t.Fatalf("patch: %d %s", w.Code, w.Body)
		}
		if got := bodies[len(bodies)-1]; got != body {
			t.Errorf("patch changed: %s", got)
		}
	}
	for _, body := range []string{`{}`, `{"users":{}}`, `{"cidr_rate_limits":[]}`, `{"user_max_tcp_conns_global_each":-1}`, `{"cidr_rate_limits":{"192.0.2.0/24":{"up_bps":1.5}}}`} {
		before := len(bodies)
		w := doRequest(t, srv, cookie, "PATCH", "/api/telemt/access-policy", map[string]string{"If-Match": "s1"}, []byte(body))
		if w.Code != 400 || len(bodies) != before {
			t.Errorf("invalid policy reached upstream: %s status %d", body, w.Code)
		}
	}
}
