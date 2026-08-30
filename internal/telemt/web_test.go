package telemt

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

// recordedWebStatusRunning is a REAL response body, recorded from a local
// Telemt 3.5.5 built from tag 3.5.5 and configured with one WEB listener on
// 127.0.0.1:18080 and one vhost profile (GET /v1/runtime/web/status). The
// only edit is the runtime_instance, replaced with a fixed hex string so the
// test is deterministic; nothing was added, removed or reordered. It is the
// evidence behind "the Go types match the Rust structs field for field" —
// TestWebStatusRoundTripsEveryRecordedField re-marshals it and compares.
const recordedWebStatusRunning = `{
 "lifecycle": "running",
 "lifecycle_epoch": 2,
 "lifecycle_age_ms": 7762,
 "available": true,
 "listeners": [
  "127.0.0.1:18080"
 ],
 "effective_config_enabled": true,
 "runtime": {
  "runtime_instance": "0123456789abcdef0123456789abcdef",
  "generation_id": 1,
  "limits": {
   "max_header_bytes": 16384,
   "max_body_bytes": 2097152,
   "max_frame_payload_bytes": 1048576,
   "carrier_batch_bytes": 2097152,
   "max_frames_per_body": 4096,
   "max_http_connections": 1024,
   "max_http_handlers": 512,
   "max_lane_open_waits_per_session": 16,
   "pending_bytes_per_lane": 8388608,
   "pending_items_per_lane": 1024,
   "websocket_bytes_global": 268435456,
   "websocket_admission_watermark_pct": 75,
   "websocket_eviction_watermark_pct": 90,
   "websocket_http_connection_reserve": 64,
   "max_websocket_evictions_in_flight": 8,
   "max_carrier_learning_entries": 4096,
   "max_body_readers": 32,
   "max_body_bytes_global": 67108864,
   "max_sessions_global": 128,
   "max_sessions_per_ip": 16,
   "max_streams_per_session": 128,
   "max_streams_global": 4096,
   "max_stream_handshakes": 256,
   "max_tombstones_per_session": 4096,
   "pending_bytes_per_session": 33554432,
   "pending_bytes_global": 536870912,
   "pending_items_per_session": 16384,
   "pending_items_global": 262144,
   "control_bytes_per_session": 262144,
   "control_bytes_global": 16777216,
   "max_bootstraps_global": 512,
   "max_bootstraps_per_ip": 64,
   "max_vhosts": 8,
   "max_profiles": 32,
   "max_static_files": 4096,
   "max_static_file_bytes": 8388608,
   "max_static_bytes": 67108864,
   "debug_records_capacity": 65536,
   "debug_bytes_global": 67108864,
   "memory_envelope_bytes": 1342177280,
   "new_bootstraps_per_minute": 1200,
   "new_bootstraps_burst": 256,
   "new_sessions_per_minute": 600,
   "new_sessions_burst": 128,
   "new_streams_per_minute": 6000,
   "new_streams_burst": 512
  },
  "manager": {
   "issuance_enabled": true,
   "issuance_generation": 1,
   "shutdown": false,
   "bootstraps": 0,
   "sessions": 0,
   "closed_tokens": 0,
   "closed_sessions": 0,
   "client_ips": 0,
   "profiles": 0
  },
  "streams": {
   "live": 0,
   "profiles": 0,
   "closed": false
  },
  "budget": {
   "queue_bytes": 0,
   "queue_items": 0,
   "control_bytes": 0,
   "control_items": 0,
   "websocket_bytes": 0,
   "high_water_bytes": 0,
   "owners": 0,
   "closed": false
  },
  "websockets": {
   "entries": 0,
   "claims": 0,
   "evictions_in_flight": 0,
   "closed": false
  },
  "learning": {
   "enabled": false,
   "aggressiveness": "conservative",
   "epoch": 1,
   "entries": 0,
   "capacity": 4096,
   "lifetime_secs": 600,
   "age_ms": 7762
  },
  "debug": {
   "policy": {
    "enabled": false,
    "capture_lifecycle": true,
    "capture_headers": true,
    "capture_timings": true,
    "capture_frames": true,
    "body_capture": "metadata",
    "body_prefix_bytes": 4096,
    "decoy_body_prefix_bytes": 4096,
    "default_window_secs": 180,
    "max_window_secs": 3600
   },
   "policy_generation": 1,
   "epoch": 1,
   "records": 0,
   "records_capacity": 65536,
   "used_bytes": 0,
   "bytes_capacity": 67108864,
   "contention_drops": 0,
   "evictions": 0,
   "byte_truncations": 0,
   "earliest_seq": null,
   "latest_seq": null
  },
  "permits": [
   [
    "http_connections",
    {
     "used": 0,
     "available": 1024,
     "capacity": 1024,
     "closed": false
    }
   ],
   [
    "http_handlers",
    {
     "used": 0,
     "available": 512,
     "capacity": 512,
     "closed": false
    }
   ],
   [
    "lane_polls",
    {
     "used": 0,
     "available": 256,
     "capacity": 256,
     "closed": false
    }
   ],
   [
    "lane_aux_polls",
    {
     "used": 0,
     "available": 128,
     "capacity": 128,
     "closed": false
    }
   ],
   [
    "body_readers",
    {
     "used": 0,
     "available": 32,
     "capacity": 32,
     "closed": false
    }
   ],
   [
    "body_bytes",
    {
     "used": 0,
     "available": 67108864,
     "capacity": 67108864,
     "closed": false
    }
   ],
   [
    "stream_handshakes",
    {
     "used": 0,
     "available": 256,
     "capacity": 256,
     "closed": false
    }
   ],
   [
    "websocket_connections",
    {
     "used": 0,
     "available": 960,
     "capacity": 960,
     "closed": false
    }
   ]
  ],
  "auxiliary_tasks": 1,
  "session_incarnations_created": 0,
  "session_incarnations_closed": 0,
  "streams_opened": 0,
  "streams_rejected": 0,
  "bytes_up": 0,
  "bytes_down": 0,
  "limit_hits": 0,
  "partial": []
 }
}`

// recordedWebStatusNoListener is the same route on the same binary started
// from a config with `web.enabled = false` and no `transport = "web"`
// listener. Recorded verbatim. Note the status code is 200, not 503: this
// route never fails, it reports the closure in its own fields.
const recordedWebStatusNoListener = `{"lifecycle":"no_web_listener","lifecycle_epoch":2,"lifecycle_age_ms":755,"available":false,"reason":"no_web_listener","listeners":[],"effective_config_enabled":false}`

// recordedWebSessionsEmpty is GET /v1/runtime/web/sessions on the running
// WEB listener with no client connected — recorded verbatim.
const recordedWebSessionsEmpty = `{"sessions":[],"next_cursor":null,"scanned":0,"scan_truncated":false,"partial_sessions":0,"partial":[]}`

// webFake serves one canned enveloped response and records the request the
// SDK actually built (path, query, and every Content-Type header).
type webFake struct {
	*httptest.Server
	path        string
	rawQuery    string
	body        string
	contentType []string
}

func newWebFake(t *testing.T, status int, data string) *webFake {
	t.Helper()
	f := &webFake{}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.path = r.URL.Path
		f.rawQuery = r.URL.RawQuery
		f.contentType = r.Header.Values("Content-Type")
		buf := make([]byte, 1<<16)
		n, _ := r.Body.Read(buf)
		f.body = string(buf[:n])
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"ok":true,"data":` + data + `,"revision":"rev-1"}`))
	}))
	t.Cleanup(f.Close)
	return f
}

func newWebErrorFake(t *testing.T, status int, code, message string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"ok":false,"error":{"code":"` + code + `","message":"` + message + `"},"request_id":1}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestWebStatusDecodesRecordedRunningSnapshot(t *testing.T) {
	fake := newWebFake(t, http.StatusOK, recordedWebStatusRunning)
	got, err := New(fake.URL, "").WebStatus(context.Background())
	if err != nil {
		t.Fatalf("WebStatus: %v", err)
	}
	if fake.path != "/v1/runtime/web/status" {
		t.Errorf("path = %q", fake.path)
	}
	if got.Lifecycle != WebLifecycleRunning || !got.Available {
		t.Errorf("lifecycle/available = %q/%v, want running/true", got.Lifecycle, got.Available)
	}
	if got.Reason != "" {
		t.Errorf("reason = %q, want empty while available", got.Reason)
	}
	if len(got.Listeners) != 1 || got.Listeners[0] != "127.0.0.1:18080" {
		t.Errorf("listeners = %v", got.Listeners)
	}
	if !got.EffectiveConfigEnabled {
		t.Error("effective_config_enabled = false, want true")
	}
	rt := got.Runtime
	if rt == nil {
		t.Fatal("runtime is nil on a running WEB listener")
	}
	if rt.RuntimeInstance != "0123456789abcdef0123456789abcdef" {
		t.Errorf("runtime_instance = %q", rt.RuntimeInstance)
	}
	// Every plane present: a healthy poll contends no lock, so `partial` is
	// empty and no plane is null.
	for name, plane := range map[string]any{
		"manager": rt.Manager, "streams": rt.Streams, "budget": rt.Budget,
		"websockets": rt.Websockets, "learning": rt.Learning, "debug": rt.Debug,
	} {
		if reflect.ValueOf(plane).IsNil() {
			t.Errorf("plane %s is nil on a healthy snapshot", name)
		}
	}
	if len(rt.Partial) != 0 {
		t.Errorf("partial = %v, want empty", rt.Partial)
	}
	if !rt.Manager.IssuanceEnabled {
		t.Error("manager.issuance_enabled = false, want true while WEB is up")
	}
	// permits is a Rust tuple array, not a map — the custom codec is the
	// only reason this decodes at all.
	if len(rt.Permits) != 8 {
		t.Fatalf("permits = %d entries, want 8", len(rt.Permits))
	}
	if rt.Permits[0].Name != "http_connections" || rt.Permits[0].Status.Capacity != 1024 {
		t.Errorf("permits[0] = %+v", rt.Permits[0])
	}
	if len(rt.Limits) == 0 {
		t.Error("limits passed through empty")
	}
	if rt.Learning.Epoch == nil || *rt.Learning.Epoch != 1 {
		t.Errorf("learning.epoch = %v, want 1", rt.Learning.Epoch)
	}
	if rt.Debug.EarliestSeq != nil || rt.Debug.LatestSeq != nil {
		t.Errorf("debug seq bounds = %v/%v, want both null", rt.Debug.EarliestSeq, rt.Debug.LatestSeq)
	}
}

// TestWebStatusRoundTripsEveryRecordedField is the field-for-field proof:
// decoding the recorded body into WebStatusData and re-encoding it must
// reproduce the same JSON tree. A field this package forgot would vanish on
// the way out; a field it renamed would appear under the wrong key. The hub
// re-marshals exactly this way, so the assertion is not academic — it is the
// contract the browser sees.
func TestWebStatusRoundTripsEveryRecordedField(t *testing.T) {
	for _, tc := range []struct {
		name string
		body string
	}{
		{"running", recordedWebStatusRunning},
		{"no_web_listener", recordedWebStatusNoListener},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var want any
			if err := json.Unmarshal([]byte(tc.body), &want); err != nil {
				t.Fatalf("decode recorded body: %v", err)
			}
			var decoded WebStatusData
			if err := json.Unmarshal([]byte(tc.body), &decoded); err != nil {
				t.Fatalf("decode into WebStatusData: %v", err)
			}
			raw, err := json.Marshal(decoded)
			if err != nil {
				t.Fatalf("re-encode: %v", err)
			}
			var got any
			if err := json.Unmarshal(raw, &got); err != nil {
				t.Fatalf("decode re-encoded: %v", err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Errorf("round trip lost or renamed fields:\n got: %s\nwant: %s", raw, tc.body)
			}
		})
	}
}

func TestWebStatusReportsClosedRuntimeWithoutAnError(t *testing.T) {
	fake := newWebFake(t, http.StatusOK, recordedWebStatusNoListener)
	got, err := New(fake.URL, "").WebStatus(context.Background())
	if err != nil {
		t.Fatalf("WebStatus: %v", err)
	}
	if got.Available || got.Reason != "no_web_listener" || got.Runtime != nil {
		t.Errorf("got %+v, want available=false reason=no_web_listener runtime=nil", got)
	}
	if got.Listeners == nil {
		t.Error("listeners is nil, want [] (normalizeSlices)")
	}
}

// TestWebRouteAbsentOnRecordedOldBuild404 is the case that matters in the
// field, and the one the predicate originally got wrong: this is the REAL
// body a live Telemt 3.4.25 answers on GET /v1/runtime/web/status — its
// router's generic 404, well-formed and with the code `not_found`. It has
// to read as "this build is too old", not as a failed poll.
func TestWebRouteAbsentOnRecordedOldBuild404(t *testing.T) {
	srv := newWebErrorFake(t, http.StatusNotFound, "not_found", "Route not found")
	if _, err := New(srv.URL, "").WebStatus(context.Background()); !IsWebRouteAbsent(err) {
		t.Errorf("WebStatus err = %v, want route-absent", err)
	}
}

// An old build may also answer a bare 404 with no envelope, which client.go
// reports as the synthetic `http_error` code. Same verdict (R5).
func TestWebRouteAbsentOnOldBuild(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("404 page not found"))
	}))
	t.Cleanup(srv.Close)
	c := New(srv.URL, "")
	if _, err := c.WebStatus(context.Background()); !IsWebRouteAbsent(err) {
		t.Errorf("WebStatus err = %v, want route-absent", err)
	}
	if _, err := c.WebSessions(context.Background(), WebSessionsQuery{}); !IsWebRouteAbsent(err) {
		t.Errorf("WebSessions err = %v, want route-absent", err)
	}
}

func TestWebRuntimeUnavailableIsNotRouteAbsent(t *testing.T) {
	srv := newWebErrorFake(t, http.StatusServiceUnavailable, CodeWebRuntimeUnavailable, "WEB runtime is unavailable: no_web_listener")
	_, err := New(srv.URL, "").WebSessions(context.Background(), WebSessionsQuery{})
	if !IsWebRuntimeUnavailable(err) {
		t.Fatalf("err = %v, want web_runtime_unavailable", err)
	}
	if IsWebRouteAbsent(err) {
		t.Error("a 503 must never read as a missing route")
	}
}

// A well-formed 404 for a ref that simply is not there must NOT be read as
// the route being absent — that is the whole of the R5 split.
func TestWebSessionNotFoundIsNotRouteAbsent(t *testing.T) {
	srv := newWebErrorFake(t, http.StatusNotFound, CodeWebSessionNotFound, "no such session")
	_, err := New(srv.URL, "").WebSession(context.Background(), "ws1.0123456789abcdef0123456789abcdef.0000000000000001")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Code != CodeWebSessionNotFound {
		t.Fatalf("err = %v, want a typed web_session_not_found", err)
	}
	if IsWebRouteAbsent(err) {
		t.Error("web_session_not_found must not read as a missing route")
	}
}

func TestWebSessionsEncodesOnlyTheWhitelistedFilters(t *testing.T) {
	fake := newWebFake(t, http.StatusOK, recordedWebSessionsEmpty)
	page, err := New(fake.URL, "").WebSessions(context.Background(), WebSessionsQuery{
		Limit: 25, Cursor: "ws1.aa.01", IP: "203.0.113.7", Host: "proxy.example.com",
		User: "web-user", UserAgentID: "0123456789abcdef0123456789abcdef",
		KeyID: "0123456789abcdef", Carrier: "https-lanes", State: "healthy",
	})
	if err != nil {
		t.Fatalf("WebSessions: %v", err)
	}
	want := "carrier=https-lanes&cursor=ws1.aa.01&host=proxy.example.com&ip=203.0.113.7&key_id=0123456789abcdef&limit=25&state=healthy&user=web-user&user_agent_id=0123456789abcdef0123456789abcdef"
	if fake.rawQuery != want {
		t.Errorf("query =\n %s\nwant\n %s", fake.rawQuery, want)
	}
	if page.Sessions == nil {
		t.Error("sessions is nil, want [] (normalizeSlices)")
	}
	if page.NextCursor != nil {
		t.Errorf("next_cursor = %v, want nil", page.NextCursor)
	}
}

func TestWebSessionsOmitsEmptyFilters(t *testing.T) {
	fake := newWebFake(t, http.StatusOK, recordedWebSessionsEmpty)
	if _, err := New(fake.URL, "").WebSessions(context.Background(), WebSessionsQuery{}); err != nil {
		t.Fatalf("WebSessions: %v", err)
	}
	// An empty `host=` is a 400 on Telemt's side, so "no filter" must mean
	// "no query string at all".
	if fake.rawQuery != "" {
		t.Errorf("rawQuery = %q, want empty", fake.rawQuery)
	}
}

func TestWebSessionsRejectsAnOutOfRangeLimitLocally(t *testing.T) {
	fake := newWebFake(t, http.StatusOK, recordedWebSessionsEmpty)
	if _, err := New(fake.URL, "").WebSessions(context.Background(), WebSessionsQuery{Limit: 201}); err == nil {
		t.Fatal("limit 201 accepted, want a local error")
	}
	if fake.path != "" {
		t.Errorf("an out-of-range limit still hit the network: %q", fake.path)
	}
}

// A synthetic row (no real client could be attached to the recording stand),
// spelled exactly as src/web/session/status.rs serializes it: session_ref
// and the optional user-agent pair beside the 23 FLATTENED status fields.
const syntheticWebSessionRow = `{"session_ref":"ws1.0123456789abcdef0123456789abcdef.0000000000000001",` +
	`"user_agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64)","user_agent_id":"fedcba9876543210fedcba9876543210",` +
	`"trace_session_id":1,"client_ip":"203.0.113.7","host":"proxy.example.com","user":"web-user",` +
	`"key_id":"0123456789abcdef","carrier":"https-lanes","attempt":1,"client_class":"bridge","automatic":true,` +
	`"state":"healthy","streams":3,"tasks":3,"lanes":4,"lane_open_waits":0,"websocket_lane_reservations":0,` +
	`"websocket_active":false,"pending_bytes":0,"pending_items":0,"control_bytes":0,"control_items":0,` +
	`"age_ms":12345,"idle_ms":120,"negotiation_remaining_ms":4200}`

func TestWebSessionDecodesTheFlattenedRow(t *testing.T) {
	fake := newWebFake(t, http.StatusOK, syntheticWebSessionRow)
	got, err := New(fake.URL, "").WebSession(context.Background(), "ws1.0123456789abcdef0123456789abcdef.0000000000000001")
	if err != nil {
		t.Fatalf("WebSession: %v", err)
	}
	if got.Closed != nil || got.Row == nil {
		t.Fatalf("got %+v, want a live row", got)
	}
	if got.Row.SessionRef == "" || got.Row.User != "web-user" || got.Row.Carrier != "https-lanes" {
		t.Errorf("row = %+v", got.Row)
	}
	if got.Row.NegotiationRemainingMs == nil || *got.Row.NegotiationRemainingMs != 4200 {
		t.Errorf("negotiation_remaining_ms = %v", got.Row.NegotiationRemainingMs)
	}
	// Round trip: the flattening must survive re-encoding, or the hub would
	// hand the browser a nested `WebSessionStatus` object nobody expects.
	raw, err := json.Marshal(got.Row)
	if err != nil {
		t.Fatalf("re-encode row: %v", err)
	}
	var want, back any
	_ = json.Unmarshal([]byte(syntheticWebSessionRow), &want)
	_ = json.Unmarshal(raw, &back)
	if !reflect.DeepEqual(back, want) {
		t.Errorf("row round trip:\n got: %s\nwant: %s", raw, syntheticWebSessionRow)
	}
}

// The tombstone arrives as HTTP 410 wrapping an ORDINARY success envelope,
// which is why it needs its own branch: decoded as a row it would look like
// a live session with 22 zeroed fields.
func TestWebSessionTombstoneIsAResultNotAnError(t *testing.T) {
	fake := newWebFake(t, http.StatusGone, `{"session_ref":"ws1.0123456789abcdef0123456789abcdef.0000000000000009","state":"closed","attempt":2}`)
	got, err := New(fake.URL, "").WebSession(context.Background(), "ws1.0123456789abcdef0123456789abcdef.0000000000000009")
	if err != nil {
		t.Fatalf("WebSession: %v", err)
	}
	if got.Row != nil {
		t.Errorf("row = %+v, want nil for a tombstone", got.Row)
	}
	if got.Closed == nil || got.Closed.State != "closed" || got.Closed.Attempt != 2 {
		t.Fatalf("closed = %+v", got.Closed)
	}
}

func TestWebSessionsCloseBuildsTheStrictControlRequest(t *testing.T) {
	fake := newWebFake(t, http.StatusAccepted, `{"operation_id":"wo1.0123456789abcdef0123456789abcdef.0000000000000001","state":"queued","high_water_session_ref":null,"requested":1,"scanned":0,"matched":0,"close_signalled":0,"conflicted":0,"created_epoch_millis":1756000000000,"updated_epoch_millis":1756000000000}`)
	op, err := New(fake.URL, "").WebSessionsClose(context.Background(), WebCloseRequest{
		RuntimeInstance: "0123456789abcdef0123456789abcdef",
		Selector: WebCloseSelector{
			Kind:        WebCloseSelectorRefs,
			SessionRefs: []string{"ws1.0123456789abcdef0123456789abcdef.0000000000000001"},
		},
	})
	if err != nil {
		t.Fatalf("WebSessionsClose: %v", err)
	}
	if fake.rawQuery != "" {
		t.Errorf("control POST carried a query string %q — Telemt 400s on any", fake.rawQuery)
	}
	// Exactly one Content-Type header, byte-exact: Telemt answers 415 for a
	// duplicate or for `application/json; charset=utf-8`.
	if len(fake.contentType) != 1 || fake.contentType[0] != "application/json" {
		t.Errorf("Content-Type = %q, want exactly one \"application/json\"", fake.contentType)
	}
	// deny_unknown_fields on the far side: the unused selector fields must
	// not be serialized.
	var body map[string]any
	if err := json.Unmarshal([]byte(fake.body), &body); err != nil {
		t.Fatalf("decode sent body %q: %v", fake.body, err)
	}
	if body["runtime_instance"] != "0123456789abcdef0123456789abcdef" {
		t.Errorf("body = %s, want the runtime fence", fake.body)
	}
	selector, _ := body["selector"].(map[string]any)
	if len(selector) != 2 || selector["kind"] != "refs" {
		t.Errorf("selector = %v, want exactly {kind, session_refs}", selector)
	}
	if op.State != WebOperationQueued || IsWebOperationTerminal(op.State) {
		t.Errorf("state = %q, want a non-terminal queued", op.State)
	}
	if op.HighWaterSessionRef != nil {
		t.Errorf("high_water_session_ref = %v, want nil", op.HighWaterSessionRef)
	}
}

func TestWebSessionsCloseRequiresTheRuntimeFence(t *testing.T) {
	fake := newWebFake(t, http.StatusAccepted, `{}`)
	c := New(fake.URL, "")
	if _, err := c.WebSessionsClose(context.Background(), WebCloseRequest{Selector: WebCloseSelector{Kind: WebCloseSelectorAll}}); err == nil {
		t.Error("close without runtime_instance accepted")
	}
	if _, err := c.WebSessionsClose(context.Background(), WebCloseRequest{RuntimeInstance: "0123456789abcdef0123456789abcdef"}); err == nil {
		t.Error("close without a selector accepted")
	}
	if fake.path != "" {
		t.Errorf("an invalid close still hit the network: %q", fake.path)
	}
}

func TestWebOperationPollsAndReportsTerminality(t *testing.T) {
	fake := newWebFake(t, http.StatusOK, `{"operation_id":"wo1.0123456789abcdef0123456789abcdef.0000000000000001","state":"completed","high_water_session_ref":"ws1.0123456789abcdef0123456789abcdef.0000000000000003","requested":1,"scanned":3,"matched":1,"close_signalled":1,"conflicted":0,"created_epoch_millis":1756000000000,"updated_epoch_millis":1756000000500}`)
	op, err := New(fake.URL, "").WebOperation(context.Background(), "wo1.0123456789abcdef0123456789abcdef.0000000000000001")
	if err != nil {
		t.Fatalf("WebOperation: %v", err)
	}
	if fake.path != "/v1/runtime/web/operations/wo1.0123456789abcdef0123456789abcdef.0000000000000001" {
		t.Errorf("path = %q", fake.path)
	}
	if !IsWebOperationTerminal(op.State) || op.CloseSignalled != 1 {
		t.Errorf("op = %+v", op)
	}
	for state, want := range map[string]bool{
		WebOperationQueued: false, WebOperationRunning: false,
		WebOperationCompleted: true, WebOperationCancelled: true, WebOperationFailed: true,
	} {
		if IsWebOperationTerminal(state) != want {
			t.Errorf("IsWebOperationTerminal(%q) = %v, want %v", state, !want, want)
		}
	}
}

// A contended plane arrives as an explicit null plus its name in `partial`.
// The page renders that as "busy", so the two halves must survive decoding
// together.
func TestWebStatusKeepsContendedPlanesApartFromAbsentOnes(t *testing.T) {
	body := `{"lifecycle":"running","lifecycle_epoch":3,"lifecycle_age_ms":10,"available":true,` +
		`"listeners":["127.0.0.1:18080"],"effective_config_enabled":true,` +
		`"runtime":{"runtime_instance":"0123456789abcdef0123456789abcdef","generation_id":1,"limits":{},` +
		`"manager":null,"streams":{"live":2,"profiles":1,"closed":false},"budget":null,"websockets":null,` +
		`"learning":null,"debug":null,"permits":[],"auxiliary_tasks":1,"session_incarnations_created":4,` +
		`"session_incarnations_closed":1,"streams_opened":9,"streams_rejected":0,"bytes_up":10,"bytes_down":20,` +
		`"limit_hits":0,"partial":["manager","budget","websockets","learning","debug"]}}`
	fake := newWebFake(t, http.StatusOK, body)
	got, err := New(fake.URL, "").WebStatus(context.Background())
	if err != nil {
		t.Fatalf("WebStatus: %v", err)
	}
	rt := got.Runtime
	if rt == nil || rt.Manager != nil || rt.Streams == nil {
		t.Fatalf("runtime = %+v, want manager nil and streams present", rt)
	}
	if len(rt.Partial) != 5 || rt.Partial[0] != "manager" {
		t.Errorf("partial = %v", rt.Partial)
	}
	if rt.Streams.Live != 2 {
		t.Errorf("streams.live = %d, want 2", rt.Streams.Live)
	}
}

func TestWebPermitRejectsANonTuple(t *testing.T) {
	var p WebPermit
	if err := json.Unmarshal([]byte(`{"name":"x"}`), &p); err == nil {
		t.Error("an object decoded as a permit tuple")
	}
	if err := json.Unmarshal([]byte(`["x"]`), &p); err == nil {
		t.Error("a one-element array decoded as a permit tuple")
	}
}
