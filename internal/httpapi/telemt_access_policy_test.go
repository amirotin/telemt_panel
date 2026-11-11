package httpapi

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

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

type accessPolicyDeadlineRecorder struct {
	*httptest.ResponseRecorder
	writeDeadline time.Time
}

func (w *accessPolicyDeadlineRecorder) SetWriteDeadline(deadline time.Time) error {
	w.writeDeadline = deadline
	return nil
}

func TestAccessPolicyPreparesResponseDeadline(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "PATCH" || r.URL.Path != "/v1/access/policy" {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte(`{"ok":true,"revision":"s2","data":{"desired":{},"effective":{},"runtime":{}}}`))
	}))
	defer upstream.Close()
	srv, _ := newTelemtInfoTestServer(t, telemt.New(upstream.URL, ""))
	deadline := time.Now().Add(30 * time.Second)
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	req := httptest.NewRequest(http.MethodPatch, "/api/telemt/access-policy", strings.NewReader(`{"user_max_tcp_conns_global_each":1}`)).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("If-Match", "s1")
	writer := &accessPolicyDeadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
	srv.handlePatchTelemtAccessPolicy(writer, req)
	if writer.Code != http.StatusOK {
		t.Fatalf("response=%d %s", writer.Code, writer.Body)
	}
	if want := deadline.Add(5 * time.Second); !writer.writeDeadline.Equal(want) {
		t.Fatalf("response write deadline=%s, want request deadline +5s (%s)", writer.writeDeadline, want)
	}
}
