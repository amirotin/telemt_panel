package httpapi

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/telemt"
	"github.com/amirotin/telemt_panel/internal/telemt/telemttest"
)

func TestPatchConfigTimeoutReportsUnknownOutcome(t *testing.T) {
	fake := telemttest.New(telemttest.Scenario{})
	defer fake.Close()
	target, _ := url.Parse(fake.URL)
	proxy := httputil.NewSingleHostReverseProxy(target)
	var patches atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPatch && r.URL.Path == "/v1/config" {
			patches.Add(1)
			select {
			case <-r.Context().Done():
			case <-time.After(time.Second):
			}
			return
		}
		proxy.ServeHTTP(w, r)
	}))
	defer upstream.Close()
	tc := telemt.New(upstream.URL, "")
	srv, cookie := newTelemtInfoTestServer(t, tc)
	if _, err := tc.Capabilities(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	r := httptest.NewRequest(http.MethodPatch, "/api/telemt/config", bytes.NewBufferString(`{"sections":{"general":{"log_level":"debug"}}}`)).WithContext(ctx)
	r.AddCookie(cookie)
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("If-Match", "cfg-old")
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)
	if patches.Load() != 1 {
		t.Fatalf("write attempts=%d, want exactly one: %s", patches.Load(), w.Body)
	}
	if w.Code != http.StatusGatewayTimeout || !strings.Contains(w.Body.String(), `"code":"telemt_config_outcome_unknown"`) {
		t.Fatalf("must distinguish unconfirmed write from rejected write: %d %s", w.Code, w.Body)
	}
}

func TestPatchConfigBareGatewayErrorReportsUnknownOutcome(t *testing.T) {
	fake := telemttest.New(telemttest.Scenario{})
	defer fake.Close()
	target, _ := url.Parse(fake.URL)
	proxy := httputil.NewSingleHostReverseProxy(target)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPatch {
			w.WriteHeader(http.StatusGatewayTimeout)
			w.Write([]byte("gateway timeout"))
			return
		}
		proxy.ServeHTTP(w, r)
	}))
	defer upstream.Close()
	srv, cookie := newTelemtInfoTestServer(t, telemt.New(upstream.URL, ""))
	w := doRequest(t, srv, cookie, http.MethodPatch, "/api/telemt/config", map[string]string{"If-Match": "cfg-old"}, []byte(`{"sections":{"general":{"log_level":"debug"}}}`))
	if !strings.Contains(w.Body.String(), `"code":"telemt_config_outcome_unknown"`) {
		t.Fatalf("bare gateway timeout must not pretend the write was rejected: %d %s", w.Code, w.Body)
	}
}

func TestPatchConfigWriteDeadlineAllowsTimeoutEnvelope(t *testing.T) {
	fake := telemttest.New(telemttest.Scenario{})
	defer fake.Close()
	target, _ := url.Parse(fake.URL)
	proxy := httputil.NewSingleHostReverseProxy(target)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPatch {
			select {
			case <-r.Context().Done():
			case <-time.After(time.Second):
			}
			return
		}
		proxy.ServeHTTP(w, r)
	}))
	defer upstream.Close()
	tc := telemt.New(upstream.URL, "")
	srv, cookie := newTelemtInfoTestServer(t, tc)
	if _, err := tc.Capabilities(context.Background()); err != nil {
		t.Fatal(err)
	}
	handler := srv.Handler()
	live := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 100*time.Millisecond)
		defer cancel()
		handler.ServeHTTP(w, r.WithContext(ctx))
	}))
	live.Config.WriteTimeout = 20 * time.Millisecond
	live.Start()
	defer live.Close()
	req, _ := http.NewRequest(http.MethodPatch, live.URL+"/api/telemt/config", bytes.NewBufferString(`{"sections":{"general":{"log_level":"debug"}}}`))
	req.AddCookie(cookie)
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("If-Match", "cfg-old")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("timeout response was lost at the socket deadline: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusGatewayTimeout {
		t.Fatalf("status=%d", resp.StatusCode)
	}
}
