package telemt

import (
	"context"
	"net/http"
	"testing"
)

func TestPosture(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/security/posture" {
			t.Errorf("path = %s", r.URL.Path)
		}
		w.Write([]byte(`{"ok":true,"data":{"api_read_only":false,"api_whitelist_enabled":true,"api_whitelist_entries":1,
			"api_auth_header_enabled":true,"proxy_protocol_enabled":false,"log_level":"info",
			"telemetry_core_enabled":true,"telemetry_user_enabled":false,"telemetry_me_level":"basic"},"revision":"r"}`))
	})

	got, err := c.Posture(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !got.APIWhitelistEnabled || got.APIWhitelistEntries != 1 || got.LogLevel != "info" {
		t.Errorf("posture = %+v", got)
	}
}

func TestWhitelist(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/security/whitelist" {
			t.Errorf("path = %s", r.URL.Path)
		}
		w.Write([]byte(`{"ok":true,"data":{"generated_at_epoch_secs":5000,"enabled":true,"entries_total":1,"entries":["127.0.0.0/8"]},"revision":"r"}`))
	})

	got, err := c.Whitelist(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !got.Enabled || got.EntriesTotal != 1 || len(got.Entries) != 1 {
		t.Errorf("whitelist = %+v", got)
	}
}
