package httpapi

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

func assertUpstreamError(t *testing.T, w *httptest.ResponseRecorder, code string) {
	t.Helper()
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, body = %s, want 502", w.Code, w.Body)
	}
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["code"] != code {
		t.Fatalf("code = %q, want %q", body["code"], code)
	}
	if strings.Contains(w.Body.String(), "UPSTREAM_SECRET") {
		t.Fatal("error response disclosed upstream data")
	}
}

func TestWriteTelemtUpstreamErrorResponseTooLarge(t *testing.T) {
	for _, gated := range []bool{false, true} {
		for _, err := range []error{telemt.ErrResponseTooLarge, fmt.Errorf("wrapped: %w", telemt.ErrResponseTooLarge)} {
			w := httptest.NewRecorder()
			writeTelemtError(w, err, gated)
			assertUpstreamError(t, w, "telemt_response_too_large")
		}
	}
}

func TestHandleTelemtInfoResponseTooLarge(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/system/info" {
			t.Errorf("unexpected capability probe: %s", r.URL.Path)
		}
		w.(http.Flusher).Flush()
		_, _ = io.Copy(w, io.MultiReader(strings.NewReader("UPSTREAM_SECRET"), strings.NewReader(strings.Repeat(" ", 8*1024*1024))))
	}))
	t.Cleanup(upstream.Close)
	s := &Server{tc: telemt.New(upstream.URL, "")}
	w := httptest.NewRecorder()
	s.handleTelemtInfo(w, httptest.NewRequest(http.MethodGet, "/api/telemt/info", nil))
	assertUpstreamError(t, w, "telemt_response_too_large")
}

func TestHandleListUsersUpstreamErrorResponseTooLarge(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", fmt.Sprint(8*1024*1024+1))
		_, _ = io.WriteString(w, "UPSTREAM_SECRET")
	}))
	t.Cleanup(upstream.Close)
	s := &Server{tc: telemt.New(upstream.URL, "")}
	w := httptest.NewRecorder()
	s.handleListUsers(w, httptest.NewRequest(http.MethodGet, "/api/users", nil))
	assertUpstreamError(t, w, "telemt_response_too_large")
}

func TestHandleListUsersUpstreamErrorMalformedBelowLimit(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"ok":true,"data":[{"username":"UPSTREAM_SECRET"}`)
	}))
	t.Cleanup(upstream.Close)
	s := &Server{tc: telemt.New(upstream.URL, "")}
	w := httptest.NewRecorder()
	s.handleListUsers(w, httptest.NewRequest(http.MethodGet, "/api/users", nil))
	assertUpstreamError(t, w, "telemt_unreachable")
}
