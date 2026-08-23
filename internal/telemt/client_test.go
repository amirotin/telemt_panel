package telemt

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
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
