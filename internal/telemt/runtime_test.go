package telemt

import (
	"context"
	"net/http"
	"testing"
)

func TestGatesFlatNotGated(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/runtime/gates" {
			t.Errorf("path = %s", r.URL.Path)
		}
		w.Write([]byte(`{"ok":true,"data":{"accepting_new_connections":true,"conditional_cast_enabled":true,
			"me_runtime_ready":true,"me2dc_fallback_enabled":false,"me2dc_fast_enabled":false,
			"use_middle_proxy":true,"route_mode":"middle_proxy","reroute_active":false,
			"startup_status":"ready","startup_stage":"done","startup_progress_pct":100},"revision":"r"}`))
	})

	gates, err := c.Gates(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !gates.AcceptingNewConnections || gates.RouteMode != "middle_proxy" {
		t.Errorf("gates = %+v", gates)
	}
	if gates.RerouteReason != "" {
		t.Errorf("expected omitted optional field to stay empty, got %q", gates.RerouteReason)
	}
}

func TestMePoolStateGatedClosed(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/runtime/me-pool-state" {
			t.Errorf("path = %s", r.URL.Path)
		}
		w.Write([]byte(`{"ok":true,"data":{"enabled":false,"reason":"source_unavailable","generated_at_epoch_secs":5000},"revision":"r"}`))
	})

	got, err := c.MePoolState(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.Enabled || got.Reason != "source_unavailable" || got.Data != nil {
		t.Errorf("me pool state = %+v", got)
	}
}

func TestMePoolStateGatedOpen(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true,"data":{"enabled":true,"generated_at_epoch_secs":5000,"data":{
			"generations":{"active_generation":3,"warm_generation":3,"pending_hardswap_generation":0,"pending_hardswap_age_secs":null,"draining_generations":[]},
			"hardswap":{"enabled":true,"pending":false},
			"writers":{"total":2,"alive_non_draining":2,"draining":0,"degraded":0,"contour":{"warm":0,"active":2,"draining":0},"health":{"healthy":2,"degraded":0,"draining":0}},
			"refill":{"inflight_endpoints_total":0,"inflight_dc_total":0,"by_dc":[]}
		}},"revision":"r"}`))
	})

	got, err := c.MePoolState(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !got.Enabled || got.Data == nil {
		t.Fatalf("me pool state = %+v", got)
	}
	if got.Data.Generations.ActiveGeneration != 3 || got.Data.Writers.Total != 2 {
		t.Errorf("data = %+v", got.Data)
	}
}

func TestUpstreamQualityBespokeShape(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/runtime/upstream-quality" {
			t.Errorf("path = %s", r.URL.Path)
		}
		w.Write([]byte(`{"ok":true,"data":{"enabled":true,"generated_at_epoch_secs":5000,
			"policy":{"connect_retry_attempts":3,"connect_retry_backoff_ms":100,"connect_budget_ms":5000,
				"unhealthy_fail_threshold":3,"connect_failfast_hard_errors":false},
			"counters":{"connect_attempt_total":50,"connect_success_total":48,"connect_fail_total":2,"connect_failfast_hard_error_total":0},
			"summary":{"configured_total":1,"healthy_total":1,"unhealthy_total":0,"direct_total":1,"socks4_total":0,"socks5_total":0,"shadowsocks_total":0}
		},"revision":"r"}`))
	})

	got, err := c.UpstreamQuality(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !got.Enabled || got.Summary == nil || got.Summary.ConfiguredTotal != 1 {
		t.Errorf("upstream quality = %+v", got)
	}
	if got.Counters.ConnectAttemptTotal != 50 {
		t.Errorf("counters = %+v", got.Counters)
	}
}

func TestEffectiveLimitsPath(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/limits/effective" {
			t.Errorf("path = %s, want /v1/limits/effective (not under /v1/runtime/)", r.URL.Path)
		}
		w.Write([]byte(`{"ok":true,"data":{"update_every_secs":5,"me_reinit_every_secs":60,"me_pool_force_close_secs":30,
			"timeouts":{"client_first_byte_idle_secs":10,"client_handshake_secs":10,"tg_connect_secs":10,"client_keepalive_secs":60,"client_ack_secs":30,"me_one_retry":1,"me_one_timeout_ms":500},
			"upstream":{"connect_retry_attempts":3,"connect_retry_backoff_ms":100,"connect_budget_ms":5000,"unhealthy_fail_threshold":3,"connect_failfast_hard_errors":false},
			"middle_proxy":{"floor_mode":"adaptive","adaptive_floor_idle_secs":60,"adaptive_floor_min_writers_single_endpoint":1,"adaptive_floor_min_writers_multi_endpoint":1,
				"adaptive_floor_recover_grace_secs":30,"adaptive_floor_writers_per_core_total":4,"adaptive_floor_cpu_cores_override":0,
				"adaptive_floor_max_extra_writers_single_per_core":2,"adaptive_floor_max_extra_writers_multi_per_core":2,
				"adaptive_floor_max_active_writers_per_core":8,"adaptive_floor_max_warm_writers_per_core":8,
				"adaptive_floor_max_active_writers_global":64,"adaptive_floor_max_warm_writers_global":64,
				"reconnect_max_concurrent_per_dc":2,"reconnect_backoff_base_ms":100,"reconnect_backoff_cap_ms":5000,"reconnect_fast_retry_count":3,
				"writer_pick_mode":"p2c","writer_pick_sample_size":2,"me2dc_fallback":false,"me2dc_fast":false},
			"user_ip_policy":{"global_each":3,"mode":"active_window","window_secs":3600},
			"user_tcp_policy":{"global_each":8}
		},"revision":"r"}`))
	})

	got, err := c.EffectiveLimits(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.MiddleProxy.FloorMode != "adaptive" || got.UserIPPolicy.GlobalEach != 3 {
		t.Errorf("limits = %+v", got)
	}
}

func TestConnectionsSummaryGatedByRuntimeEdge(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/runtime/connections/summary" {
			t.Errorf("path = %s", r.URL.Path)
		}
		w.Write([]byte(`{"ok":true,"data":{"enabled":false,"reason":"feature_disabled","generated_at_epoch_secs":5000},"revision":"r"}`))
	})

	got, err := c.ConnectionsSummary(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.Enabled || got.Data != nil {
		t.Errorf("connections summary = %+v", got)
	}
}

func TestRecentEventsLimitQueryParam(t *testing.T) {
	var gotQuery string
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		w.Write([]byte(`{"ok":true,"data":{"enabled":true,"generated_at_epoch_secs":5000,
			"data":{"capacity":200,"dropped_total":0,"events":[]}},"revision":"r"}`))
	})

	if _, err := c.RecentEvents(context.Background(), 25); err != nil {
		t.Fatal(err)
	}
	if gotQuery != "limit=25" {
		t.Errorf("query = %q, want limit=25", gotQuery)
	}
}

func TestRecentEventsNoLimitOmitsQuery(t *testing.T) {
	var gotQuery string
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		w.Write([]byte(`{"ok":true,"data":{"enabled":true,"generated_at_epoch_secs":5000,
			"data":{"capacity":200,"dropped_total":0,"events":[]}},"revision":"r"}`))
	})

	if _, err := c.RecentEvents(context.Background(), 0); err != nil {
		t.Fatal(err)
	}
	if gotQuery != "" {
		t.Errorf("query = %q, want empty", gotQuery)
	}
}

func TestTLSFingerprintsDecodesRows(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/runtime/tls-fingerprints" {
			t.Errorf("path = %s", r.URL.Path)
		}
		w.Write([]byte(`{"ok":true,"data":{"enabled":true,"generated_at_epoch_secs":5000,"data":{
			"limit":50,"retention_secs":900,"capacity":500,"dropped_total":0,"parse_error_total":0,
			"by_fingerprint":[{"ja3":"aaaa","ja3_raw":"raw","ja4":"bbbb","ja4_raw":"raw2","total":5,"auth_success":5,"bad_or_probe":0,"first_seen_epoch_secs":100,"last_seen_epoch_secs":5000}],
			"by_ip":[],"by_cidr":[],"by_user":[]
		}},"revision":"r"}`))
	})

	got, err := c.TLSFingerprints(context.Background(), 50)
	if err != nil {
		t.Fatal(err)
	}
	if got.Data == nil || len(got.Data.ByFingerprint) != 1 || got.Data.ByFingerprint[0].JA3 != "aaaa" {
		t.Errorf("tls fingerprints = %+v", got)
	}
}
