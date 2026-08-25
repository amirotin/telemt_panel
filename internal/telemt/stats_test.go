package telemt

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestZeroAllTopLevelTypedLeavesGeneric(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/stats/zero/all" {
			t.Errorf("path = %s", r.URL.Path)
		}
		// Mixed leaf types within one section (bool/string/int/array) — the
		// "known rake": a naive map[string]int64 leaf would fail to decode this.
		w.Write([]byte(`{"ok":true,"data":{"generated_at_epoch_secs":5000,
			"core":{"uptime_seconds":3600,"telemetry_me_level":"basic","conntrack_pressure_active":false,
				"connections_bad_by_class":[{"class":"timeout","total":2}]},
			"upstream":{"connect_attempt_total":50},
			"middle_proxy":{"keepalive_sent_total":10},
			"pool":{"pool_swap_total":2},
			"desync":{"desync_total":0}
		},"revision":"r"}`))
	})

	got, err := c.ZeroAll(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.GeneratedAtEpochSecs != 5000 {
		t.Errorf("generated_at_epoch_secs = %d", got.GeneratedAtEpochSecs)
	}
	var level string
	if err := json.Unmarshal(got.Core["telemetry_me_level"], &level); err != nil || level != "basic" {
		t.Errorf("core.telemetry_me_level decode = %v %q", err, level)
	}
	var badByClass []ClassCount
	if err := json.Unmarshal(got.Core["connections_bad_by_class"], &badByClass); err != nil || len(badByClass) != 1 {
		t.Errorf("core.connections_bad_by_class decode = %v %+v", err, badByClass)
	}
}

func TestUpstreamsDisabledStillHasZero(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true,"data":{"enabled":false,"reason":"feature_disabled","generated_at_epoch_secs":5000,
			"zero":{"connect_attempt_total":0,"connect_success_total":0,"connect_fail_total":0,"connect_failfast_hard_error_total":0,
				"connect_attempts_bucket_1":0,"connect_attempts_bucket_2":0,"connect_attempts_bucket_3_4":0,"connect_attempts_bucket_gt_4":0,
				"connect_duration_success_bucket_le_100ms":0,"connect_duration_success_bucket_101_500ms":0,
				"connect_duration_success_bucket_501_1000ms":0,"connect_duration_success_bucket_gt_1000ms":0,
				"connect_duration_fail_bucket_le_100ms":0,"connect_duration_fail_bucket_101_500ms":0,
				"connect_duration_fail_bucket_501_1000ms":0,"connect_duration_fail_bucket_gt_1000ms":0}
		},"revision":"r"}`))
	})

	got, err := c.Upstreams(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.Enabled || got.Summary != nil {
		t.Errorf("upstreams = %+v", got)
	}
	// Upstreams is a genuine JSON array field (unlike Summary, an optional
	// pointer): normalizeSlices turns its omitted-field nil into a non-nil
	// empty slice — "arrays are always [], never null".
	if got.Upstreams == nil || len(got.Upstreams) != 0 {
		t.Errorf("Upstreams = %#v, want non-nil empty", got.Upstreams)
	}
}

func TestUpstreamsEnabledWithRows(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true,"data":{"enabled":true,"generated_at_epoch_secs":5000,
			"zero":{"connect_attempt_total":50,"connect_success_total":48,"connect_fail_total":2,"connect_failfast_hard_error_total":0,
				"connect_attempts_bucket_1":0,"connect_attempts_bucket_2":0,"connect_attempts_bucket_3_4":0,"connect_attempts_bucket_gt_4":0,
				"connect_duration_success_bucket_le_100ms":0,"connect_duration_success_bucket_101_500ms":0,
				"connect_duration_success_bucket_501_1000ms":0,"connect_duration_success_bucket_gt_1000ms":0,
				"connect_duration_fail_bucket_le_100ms":0,"connect_duration_fail_bucket_101_500ms":0,
				"connect_duration_fail_bucket_501_1000ms":0,"connect_duration_fail_bucket_gt_1000ms":0},
			"summary":{"configured_total":1,"healthy_total":1,"unhealthy_total":0,"direct_total":1,"socks4_total":0,"socks5_total":0,"shadowsocks_total":0},
			"upstreams":[{"upstream_id":1,"route_kind":"direct","address":"198.51.100.1:443","weight":1,"scopes":"all",
				"healthy":true,"fails":0,"last_check_age_secs":5,"effective_latency_ms":12.5,
				"dc":[{"dc":2,"latency_ema_ms":12.5,"ip_preference":"prefer_v4"}]}]
		},"revision":"r"}`))
	})

	got, err := c.Upstreams(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !got.Enabled || got.Summary == nil || len(got.Upstreams) != 1 {
		t.Fatalf("upstreams = %+v", got)
	}
	if got.Upstreams[0].RouteKind != "direct" || got.Upstreams[0].DC[0].DC != 2 {
		t.Errorf("upstreams[0] = %+v", got.Upstreams[0])
	}
}

func TestMinimalAllGated(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/stats/minimal/all" {
			t.Errorf("path = %s", r.URL.Path)
		}
		w.Write([]byte(`{"ok":true,"data":{"enabled":false,"reason":"feature_disabled","generated_at_epoch_secs":5000},"revision":"r"}`))
	})

	got, err := c.MinimalAll(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.Enabled || got.Data != nil {
		t.Errorf("minimal all = %+v", got)
	}
}

func TestDCsAndMeWritersAlwaysPresentArrays(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/stats/dcs":
			w.Write([]byte(`{"ok":true,"data":{"middle_proxy_enabled":false,"reason":"feature_disabled","generated_at_epoch_secs":5000,"dcs":[]},"revision":"r"}`))
		case "/v1/stats/me-writers":
			w.Write([]byte(`{"ok":true,"data":{"middle_proxy_enabled":false,"reason":"feature_disabled","generated_at_epoch_secs":5000,
				"summary":{"configured_dc_groups":0,"configured_endpoints":0,"available_endpoints":0,"available_pct":0,
					"required_writers":0,"alive_writers":0,"coverage_pct":0,"fresh_alive_writers":0,"fresh_coverage_pct":0},
				"writers":[]},"revision":"r"}`))
		default:
			t.Errorf("path = %s", r.URL.Path)
		}
	})

	dcs, err := c.DCs(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if dcs.MiddleProxyEnabled || dcs.DCs == nil || len(dcs.DCs) != 0 {
		t.Errorf("dcs = %+v", dcs)
	}

	writers, err := c.MeWriters(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if writers.MiddleProxyEnabled || writers.Writers == nil {
		t.Errorf("writers = %+v", writers)
	}
}

func TestActiveIPsOnlyNonEmpty(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/stats/users/active-ips" {
			t.Errorf("path = %s", r.URL.Path)
		}
		w.Write([]byte(`{"ok":true,"data":[{"username":"alice","active_ips":["10.0.0.1"]}],"revision":"r"}`))
	})

	got, err := c.ActiveIPs(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Username != "alice" || got[0].ActiveIPs[0] != "10.0.0.1" {
		t.Errorf("active ips = %+v", got)
	}
}
