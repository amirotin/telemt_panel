package httpapi

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

func TestTelemtErrorDiagnostics(t *testing.T) {
	var malformed any
	decodeErr := json.Unmarshal([]byte(`{"UPSTREAM_SECRET":`), &malformed)
	apiFailure := func(message string) error {
		return &telemt.APIError{Status: 500, Code: "internal_error", Message: message, RequestID: 42}
	}
	cases := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"config ownership", apiFailure("failed to write config: Operation not permitted (os error 1)"), 502, "telemt_config_permission_denied"},
		{"config directory permissions", apiFailure("failed to write config: Permission denied (os error 13)"), 502, "telemt_config_permission_denied"},
		{"config read permissions", apiFailure("failed to read config graph: Permission denied (os error 13)"), 502, "telemt_config_permission_denied"},
		{"read-only filesystem", apiFailure("failed to write config: Read-only file system (os error 30)"), 502, "telemt_config_read_only"},
		{"full filesystem", apiFailure("failed to write config: No space left on device (os error 28)"), 502, "telemt_config_storage_full"},
		{"filesystem quota", apiFailure("failed to write config: Disk quota exceeded (os error 122)"), 502, "telemt_config_storage_full"},
		{"other config write", apiFailure("failed to write config: Device or resource busy (os error 16)"), 502, "telemt_config_write_failed"},
		{"config source missing", apiFailure("failed to read config graph: No such file or directory (os error 2)"), 502, "telemt_config_read_failed"},
		{"other upstream error", apiFailure("UPSTREAM_SECRET"), 502, "telemt_api_error"},
		{"unrelated permissions", apiFailure("failed to open certificate: Permission denied"), 502, "telemt_api_error"},
		{"bare gateway", &telemt.APIError{Status: 502, Code: "http_error", Message: "UPSTREAM_SECRET"}, 502, "telemt_api_error"},
		{"upstream gateway timeout", &telemt.APIError{Status: 504, Code: "http_error", Message: "UPSTREAM_SECRET"}, 504, "telemt_timeout"},
		{"upstream authentication", &telemt.APIError{Status: 401, Code: "unauthorized", Message: "UPSTREAM_SECRET"}, 502, "telemt_auth_failed"},
		{"request deadline", fmt.Errorf("request: %w", context.DeadlineExceeded), 504, "telemt_timeout"},
		{"network timeout", &net.DNSError{Err: "i/o timeout", Name: "UPSTREAM_SECRET", IsTimeout: true}, 504, "telemt_timeout"},
		{"DNS", &net.DNSError{Err: "no such host", Name: "UPSTREAM_SECRET", IsNotFound: true}, 502, "telemt_dns_failed"},
		{"certificate", x509.UnknownAuthorityError{Cert: &x509.Certificate{}}, 502, "telemt_tls_failed"},
		{"malformed payload", fmt.Errorf("decode users: %w", decodeErr), 502, "telemt_invalid_response"},
		{"truncated response", fmt.Errorf("read response: %w", io.ErrUnexpectedEOF), 502, "telemt_invalid_response"},
		{"connection", &url.Error{Op: "Get", URL: "http://admin:UPSTREAM_SECRET@telemt.invalid", Err: syscall.ECONNREFUSED}, 502, "telemt_unreachable"},
		{"oversized response", telemt.ErrResponseTooLarge, 502, "telemt_response_too_large"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, gated := range []bool{false, true} {
				w := httptest.NewRecorder()
				writeTelemtError(w, fmt.Errorf("wrapped: %w", tc.err), gated)
				if w.Code != tc.status {
					t.Errorf("status = %d, want %d", w.Code, tc.status)
				}
				var body map[string]string
				if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
					t.Fatal(err)
				}
				if body["code"] != tc.code {
					t.Errorf("code = %q, want %q", body["code"], tc.code)
				}
				if strings.Contains(w.Body.String(), "UPSTREAM_SECRET") {
					t.Fatal("diagnostic disclosed upstream payload or credentials")
				}
			}
		})
	}
}

func TestSublinkReportsConfigReadFailure(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(500)
		fmt.Fprint(w, `{"ok":false,"error":{"code":"internal_error","message":"failed to read config graph: Permission denied (os error 13)"}}`)
	}))
	t.Cleanup(upstream.Close)
	s := &Server{tc: telemt.New(upstream.URL, "")}
	w := httptest.NewRecorder()
	s.handleGetSublink(w, httptest.NewRequest("GET", "/api/users/bob/sublink", nil))
	assertUpstreamError(t, w, "telemt_config_permission_denied")
}

func TestCreateUserConfigPermissionDiagnostic(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/v1/users" {
			t.Errorf("unexpected upstream request: %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprint(w, `{"ok":false,"request_id":42,"error":{"code":"internal_error","message":"failed to write config: Operation not permitted (os error 1)"}}`)
	}))
	t.Cleanup(upstream.Close)
	s := &Server{tc: telemt.New(upstream.URL, "")}
	w := httptest.NewRecorder()
	s.handleCreateUser(w, httptest.NewRequest("POST", "/api/users", strings.NewReader(`{"username":"bob"}`)))
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if w.Code != 502 || body["code"] != "telemt_config_permission_denied" {
		t.Fatalf("status=%d body=%s, want a config permission diagnosis", w.Code, w.Body)
	}
	if body["message"] != "HTTP 500 · internal_error · #42" {
		t.Errorf("message = %q, want safe upstream status/code/request ID", body["message"])
	}
}

func TestTelemtDiagnosticRejectsUntrustedUpstreamCode(t *testing.T) {
	w := httptest.NewRecorder()
	writeTelemtError(w, &telemt.APIError{
		Status: 500, Code: "internal_error\nAuthorization: UPSTREAM_SECRET", Message: "UPSTREAM_SECRET", RequestID: 7,
	}, false)
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["message"] != "HTTP 500 · #7" {
		t.Fatalf("untrusted metadata was not excluded: %s", w.Body)
	}
}

func TestSnapshotReportsUpstreamDiagnostic(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(500)
		fmt.Fprint(w, `{"ok":false,"request_id":42,"error":{"code":"internal_error","message":"UPSTREAM_SECRET"}}`)
	}))
	t.Cleanup(upstream.Close)
	h := hub.New(hub.Config{}, telemt.New(upstream.URL, ""), nil)
	t.Cleanup(h.Close)
	s := &Server{hub: h}
	w := httptest.NewRecorder()
	s.handleSnapshot(w, httptest.NewRequest("GET", "/api/snapshot?topics=users", nil))
	assertUpstreamError(t, w, "telemt_api_error")
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["message"] != "HTTP 500 · internal_error · #42" {
		t.Fatalf("snapshot lost upstream diagnostic: %s", w.Body)
	}
}

func TestSnapshotWithoutPublishedUpdateDoesNotBlameTelemt(t *testing.T) {
	h := hub.New(hub.Config{}, telemt.New("http://127.0.0.1:1", ""), nil)
	t.Cleanup(h.Close)
	s := &Server{hub: h}
	w := httptest.NewRecorder()
	s.handleSnapshot(w, httptest.NewRequest("GET", "/api/snapshot?topics=update", nil))
	assertUpstreamError(t, w, "snapshot_unavailable")
}

func TestSnapshotExpiredDeadlineIsNotMissingData(t *testing.T) {
	h := hub.New(hub.Config{}, telemt.New("http://127.0.0.1:1", ""), nil)
	t.Cleanup(h.Close)
	s := &Server{hub: h}
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	w := httptest.NewRecorder()
	s.handleSnapshot(w, httptest.NewRequest("GET", "/api/snapshot?topics=users", nil).WithContext(ctx))
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if w.Code != 504 || body["code"] != "telemt_timeout" {
		t.Fatalf("status=%d body=%s, want a timeout diagnosis", w.Code, w.Body)
	}
}
