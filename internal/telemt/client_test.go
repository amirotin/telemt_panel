package telemt

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return New(srv.URL, "test-secret")
}

func TestHealthEnvelope(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/health" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "test-secret" {
			t.Errorf("auth header = %q", got)
		}
		w.Write([]byte(`{"ok":true,"data":{"status":"ok","read_only":true},"revision":"abc"}`))
	})

	h, err := c.Health(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if h.Status != "ok" || !h.ReadOnly {
		t.Errorf("health = %+v", h)
	}
}

func TestErrorEnvelope(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		w.Write([]byte(`{"ok":false,"error":{"code":"revision_conflict","message":"config changed"},"request_id":42}`))
	})

	_, err := c.Health(context.Background())
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("want APIError, got %v", err)
	}
	if apiErr.Code != "revision_conflict" || apiErr.Status != 409 || apiErr.RequestID != 42 {
		t.Errorf("apiErr = %+v", apiErr)
	}
}

func TestSystemInfoLegacyFlat(t *testing.T) {
	// Older Telemt builds return /v1/system/info without the envelope.
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"version":"3.3.10","config_path":"/etc/telemt/telemt.toml"}`))
	})

	info, err := c.SystemInfo(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if info.Version != "3.3.10" || info.ConfigPath != "/etc/telemt/telemt.toml" {
		t.Errorf("info = %+v", info)
	}
}

// TestSystemInfoOptionalBuildAndReloadFields pins the three
// skip_serializing_if=None fields Telemt's api/runtime_zero.rs
// SystemInfoData can send: last_config_reload_epoch_secs (present in the
// production snapshot, TELEMT_LIVE_API_DATA.md §5) plus the two build-env
// fields. Absent keys must stay distinguishable from a real zero.
func TestSystemInfoOptionalBuildAndReloadFields(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true,"data":{"version":"3.5.2","target_arch":"x86_64","target_os":"linux",
			"build_profile":"release","git_commit":"abc123","build_time_utc":"2026-08-01T00:00:00Z",
			"rustc_version":"1.89.0","process_started_at_epoch_secs":1000,"uptime_seconds":3600,
			"config_path":"/etc/telemt/telemt.toml","config_hash":"r1","config_reload_count":2,
			"last_config_reload_epoch_secs":1755000000},"revision":"r1"}`))
	})

	info, err := c.SystemInfo(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if info.BuildTimeUTC != "2026-08-01T00:00:00Z" || info.RustcVersion != "1.89.0" {
		t.Errorf("build env fields = %+v", info)
	}
	if info.LastConfigReloadEpochSecs == nil || *info.LastConfigReloadEpochSecs != 1755000000 {
		t.Errorf("last_config_reload_epoch_secs = %v, want 1755000000", info.LastConfigReloadEpochSecs)
	}

	// Never reloaded: Telemt omits the key entirely — a nil pointer, not 0.
	c2 := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true,"data":{"version":"3.5.2","config_reload_count":0},"revision":"r1"}`))
	})
	info2, err := c2.SystemInfo(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if info2.LastConfigReloadEpochSecs != nil {
		t.Errorf("last_config_reload_epoch_secs = %v, want nil when omitted", *info2.LastConfigReloadEpochSecs)
	}
	if info2.BuildTimeUTC != "" || info2.RustcVersion != "" {
		t.Errorf("build env fields = %+v, want empty when omitted", info2)
	}
}

func TestUsers(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true,"data":[
			{"username":"alice","enabled":true,"in_runtime":true,"data_quota_bytes":1024,
			 "current_connections":2,"active_unique_ips":1,"active_unique_ips_list":["10.0.0.1"],
			 "recent_unique_ips":1,"recent_unique_ips_list":["10.0.0.1"],"total_octets":99,
			 "links":{"classic":["tg://proxy?server=h&port=443&secret=s"],"secure":[],"tls":[],"tls_domains":[]}}
		],"revision":"r1"}`))
	})

	users, err := c.Users(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(users) != 1 || users[0].Username != "alice" {
		t.Fatalf("users = %+v", users)
	}
	u := users[0]
	if u.DataQuotaBytes == nil || *u.DataQuotaBytes != 1024 {
		t.Errorf("quota = %v", u.DataQuotaBytes)
	}
	if u.MaxTCPConns != nil {
		t.Errorf("absent optional field must stay nil, got %v", *u.MaxTCPConns)
	}
	if len(u.Links.Classic) != 1 {
		t.Errorf("links = %+v", u.Links)
	}
}

func TestStatsSummary(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/stats/summary" {
			t.Errorf("path = %s", r.URL.Path)
		}
		w.Write([]byte(`{"ok":true,"data":{
			"uptime_seconds":12.5,"connections_total":10,"connections_bad_total":2,
			"handshake_timeouts_total":1,"configured_users":3,
			"connections_bad_by_class":[{"class":"timeout","total":2}],
			"handshake_failures_by_class":[{"class":"tls","total":1}]
		},"revision":"r1"}`))
	})

	s, err := c.StatsSummary(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if s.UptimeSeconds != 12.5 || s.ConnectionsTotal != 10 || s.ConfiguredUsers != 3 {
		t.Errorf("summary = %+v", s)
	}
	if len(s.ConnectionsBadByClass) != 1 || s.ConnectionsBadByClass[0].Class != "timeout" {
		t.Errorf("connections_bad_by_class = %+v", s.ConnectionsBadByClass)
	}
	if len(s.HandshakeFailuresByClass) != 1 || s.HandshakeFailuresByClass[0].Total != 1 {
		t.Errorf("handshake_failures_by_class = %+v", s.HandshakeFailuresByClass)
	}
}

func TestStatsSummaryOmitsByClassOnOldBuild(t *testing.T) {
	// Older Telemt builds don't send the by-class breakdowns at all.
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true,"data":{"uptime_seconds":1,"connections_total":0,
			"connections_bad_total":0,"handshake_timeouts_total":0,"configured_users":1},"revision":"r1"}`))
	})

	s, err := c.StatsSummary(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// normalizeSlices (normalize.go) turns the omitted-field nil slice
	// into a non-nil empty one — the panel's output contract is "arrays
	// are always [], never null" — so this now asserts emptiness (the
	// meaningful part of "old build didn't send these") rather than
	// literal Go nilness.
	if s.ConnectionsBadByClass == nil || len(s.ConnectionsBadByClass) != 0 {
		t.Errorf("ConnectionsBadByClass = %#v, want non-nil empty", s.ConnectionsBadByClass)
	}
	if s.HandshakeFailuresByClass == nil || len(s.HandshakeFailuresByClass) != 0 {
		t.Errorf("HandshakeFailuresByClass = %#v, want non-nil empty", s.HandshakeFailuresByClass)
	}
}

func TestStatsSummaryRejectsMalformedSuccessfulResponse(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/stats/summary" {
			t.Errorf("path = %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{`))
	})

	_, err := c.StatsSummary(context.Background())
	var syntaxErr *json.SyntaxError
	if !errors.As(err, &syntaxErr) {
		t.Fatalf("StatsSummary malformed 200 response error = %v, want JSON syntax error", err)
	}
}

func TestNonJSONErrorResponse(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		w.Write([]byte("<html>upstream error</html>"))
	})

	_, err := c.Health(context.Background())
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 502 {
		t.Fatalf("want APIError 502, got %v", err)
	}
}

const testUpstreamBodyLimit = 8 * 1024 * 1024

type testWhitespaceReader struct{}

func (testWhitespaceReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = ' '
	}
	return len(p), nil
}

func paddedUpstreamBody(payload string, size int) io.Reader {
	return io.MultiReader(strings.NewReader(payload), io.LimitReader(testWhitespaceReader{}, int64(size-len(payload))))
}

type trackedUpstreamBody struct {
	io.Reader
	bytesRead int
	closed    bool
}

func (b *trackedUpstreamBody) Read(p []byte) (int, error) {
	n, err := b.Reader.Read(p)
	b.bytesRead += n
	return n, err
}

func (b *trackedUpstreamBody) Close() error {
	b.closed = true
	return nil
}

func newBodyLimitTestClient(reader io.Reader, contentLength int64, status int) (*Client, *trackedUpstreamBody) {
	body := &trackedUpstreamBody{Reader: reader}
	c := New("http://telemt.test", "")
	c.http.Transport = testRoundTripper(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: status, Header: make(http.Header), Body: body, ContentLength: contentLength}, nil
	})
	return c, body
}

func TestBodyLimitResponseTooLargeBoundaries(t *testing.T) {
	const success = `{"ok":true,"data":{"status":"ok"}}`
	const flat = `{"status":"ok"}`
	const malformed = `{"ok":true,"data":{"status":`
	for _, tc := range []struct {
		name          string
		payload       string
		bodyBytes     int
		contentLength int64
		status        int
		wantLarge     bool
		wantSyntax    bool
	}{
		{"exact limit with length", success, testUpstreamBodyLimit, testUpstreamBodyLimit, 200, false, false},
		{"exact limit without length", success, testUpstreamBodyLimit, -1, 200, false, false},
		{"legacy flat exact limit", flat, testUpstreamBodyLimit, -1, 200, false, false},
		{"small body overclaimed within limit", success, len(success), testUpstreamBodyLimit, 200, false, false},
		{"limit plus one with length", success, testUpstreamBodyLimit + 1, testUpstreamBodyLimit + 1, 200, true, false},
		{"limit plus one without length", success, testUpstreamBodyLimit + 1, -1, 200, true, false},
		{"limit plus one underclaimed length", success, testUpstreamBodyLimit + 1, 1, 200, true, false},
		{"limit plus one zero length", success, testUpstreamBodyLimit + 1, 0, 200, true, false},
		{"small body claimed over limit", success, len(success), testUpstreamBodyLimit + 1, 200, true, false},
		{"malformed below limit", malformed, len(malformed), -1, 200, false, true},
		{"truncated JSON exact limit", malformed, testUpstreamBodyLimit, testUpstreamBodyLimit, 200, false, true},
		{"oversized non-JSON error", "UPSTREAM_SECRET", testUpstreamBodyLimit + 1, -1, 404, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, body := newBodyLimitTestClient(paddedUpstreamBody(tc.payload, tc.bodyBytes), tc.contentLength, tc.status)
			health, err := c.Health(context.Background())
			if tc.wantLarge {
				if !errors.Is(err, ErrResponseTooLarge) {
					t.Fatalf("error = %v, want ErrResponseTooLarge (read %d bytes)", err, body.bytesRead)
				}
				if strings.Contains(err.Error(), "UPSTREAM_SECRET") {
					t.Fatal("size error exposed the upstream body")
				}
			} else if tc.wantSyntax {
				var syntaxErr *json.SyntaxError
				if errors.Is(err, ErrResponseTooLarge) || !errors.As(err, &syntaxErr) {
					t.Fatalf("error = %v, want JSON syntax error below or at limit", err)
				}
			} else if err != nil || health.Status != "ok" {
				t.Fatalf("health = %+v, error = %v, want valid response", health, err)
			}
			if body.bytesRead > testUpstreamBodyLimit+1 {
				t.Fatalf("read %d bytes, maximum is limit+1", body.bytesRead)
			}
			if !body.closed {
				t.Fatal("response body was not closed")
			}
		})
	}
}

func TestResponseTooLargeReadBound(t *testing.T) {
	for _, contentLength := range []int64{-1, 1, testUpstreamBodyLimit + 1} {
		t.Run(fmt.Sprint(contentLength), func(t *testing.T) {
			c, body := newBodyLimitTestClient(testWhitespaceReader{}, contentLength, http.StatusOK)
			_, err := c.Health(context.Background())
			if !errors.Is(err, ErrResponseTooLarge) {
				t.Fatalf("error = %v, want ErrResponseTooLarge", err)
			}
			wantRead := testUpstreamBodyLimit + 1
			if contentLength > testUpstreamBodyLimit {
				wantRead = 0
			}
			if body.bytesRead != wantRead {
				t.Fatalf("read %d bytes, want %d with unbounded upstream", body.bytesRead, wantRead)
			}
			if !body.closed {
				t.Fatal("unbounded body was not closed")
			}
		})
	}
}

func TestResponseTooLargeChunkedWithoutLength(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.(http.Flusher).Flush()
		_, _ = io.Copy(w, paddedUpstreamBody(`{"ok":true,"data":{"status":"ok"}}`, testUpstreamBodyLimit+1))
	}))
	t.Cleanup(srv.Close)
	c := New(srv.URL, "")
	var chunked bool
	c.http.Transport = testRoundTripper(func(r *http.Request) (*http.Response, error) {
		resp, err := http.DefaultTransport.RoundTrip(r)
		if err == nil {
			chunked = resp.ContentLength == -1 && len(resp.TransferEncoding) == 1 && resp.TransferEncoding[0] == "chunked"
		}
		return resp, err
	})
	_, err := c.Health(context.Background())
	if !chunked {
		t.Fatal("fixture did not return a chunked response without Content-Length")
	}
	if !errors.Is(err, ErrResponseTooLarge) {
		t.Fatalf("chunked response error = %v, want ErrResponseTooLarge", err)
	}
}

func TestBodyLimitUsersScaleFixture(t *testing.T) {
	// Match the 2,000-user fixture in web/src/people/users.helpers.test.ts.
	users := make([]UserInfo, 2000)
	for i := range users {
		users[i] = UserInfo{
			Username: fmt.Sprintf("scale-%04d", i), Enabled: true, InRuntime: true,
			ActiveIPList: []string{}, RecentIPList: []string{},
			Links: UserLinks{Classic: []string{}, Secure: []string{}, TLS: []string{}, TLSDomains: []TLSDomainLink{}},
		}
	}
	raw, err := json.Marshal(struct {
		OK   bool       `json:"ok"`
		Data []UserInfo `json:"data"`
	}{true, users})
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) > testUpstreamBodyLimit {
		t.Fatalf("scale fixture has %d bytes, exceeds retained 8 MiB limit", len(raw))
	}
	c, body := newBodyLimitTestClient(strings.NewReader(string(raw)), int64(len(raw)), http.StatusOK)
	got, err := c.Users(context.Background())
	if err != nil || len(got) != 2000 || got[0].Username != "scale-0000" || got[1999].Username != "scale-1999" {
		t.Fatalf("scale users count = %d, error = %v", len(got), err)
	}
	t.Logf("current scale fixture: %d users, %d response bytes, %d bytes read", len(got), len(raw), body.bytesRead)
}

func BenchmarkResponseTooLargeReadBound(b *testing.B) {
	c, body := newBodyLimitTestClient(testWhitespaceReader{}, -1, http.StatusOK)
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		body.bytesRead = 0
		_, err := c.Health(context.Background())
		if !errors.Is(err, ErrResponseTooLarge) || body.bytesRead != testUpstreamBodyLimit+1 {
			b.Fatalf("error = %v, read %d bytes", err, body.bytesRead)
		}
	}
	b.ReportMetric(float64(body.bytesRead), "read-B/op")
}
