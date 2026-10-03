package telemt

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"testing"
)

// Constructed from tag 3.5.8 (717a347) WEB observability DTOs, rather than
// recorded from a client session. The runtime portion remains the recorded
// 3.5.5 fixture to verify that adding telemetry does not rewrite its planes.
const webStatus358Observability = `{
  "ingress": {
    "configured_listeners": 2, "live_acceptors": 1, "accepting_connections": false,
    "reason": "acceptor_unavailable", "tcp_accept_total": 91, "tcp_accept_error_total": 3
  },
  "capacity": {
    "http_connection_capacity_action": "future_action",
    "max_http_overload_connections": 4, "http_overload_timeout_ms": 800,
    "resources": [
      {"resource":"http_connections","unit":"slots","used":8,"available":0,"limit":8,"closed":false},
      {"resource":"future_resource","unit":"credits","used":3,"available":7,"limit":10,"closed":false}
    ],
    "saturated_resources": ["http_connections"], "partial": ["budget"],
    "rejections": [{"reason":"future_rejection","total":18446744073709551615}],
    "http_connection_overload_outcomes": [{"outcome":"future_outcome","total":5}]
  },
  "decoy_upstream": {
    "outcomes": [{"outcome":"connect_timeout","total":7}],
    "last_outcome": "connect_timeout", "last_outcome_age_ms": 0
  },
  "decoy_fasttrack": {"mode":"future_mode","requests":[{"disposition":"future_disposition","total":2}]},
  "carrier_negotiation": {
    "selections":[{"carrier":"future_carrier","disposition":"future_selection","total":3}],
    "reported_failures":[{"carrier":"future_carrier","phase":"future_phase","reason":"future_failure","total":4}],
    "learning_outcomes":[{"carrier":"future_carrier","outcome":"future_learning","total":5}]
  },
  "lifecycle_counters": {
    "bridge_recovery_secs":40,
    "session_closures":[{"carrier":"future_carrier","reason":"future_close","total":6}],
    "session_observations":[{"carrier":"future_carrier","observation":"future_observation","total":7}],
    "bridge_recovery_events":[{"event":"future_event","total":8}]
  },
  "operator_lifecycle": {
    "state":"future_state","epoch":9,"age_ms":500,"admission_open":false,"effective_new_work_admission":false,
    "drain":{"operation_id":"drain-id","state":"future_drain","outcome":"future_terminal","timeout_secs":30,
      "started_epoch_millis":1000,"deadline_epoch_millis":31000,"completed_epoch_millis":0,
      "remaining_sessions":2,"remaining_streams":3,"remaining_websockets":1,"force_close_signalled":true}
  }
}`

func webJSONTree(t *testing.T, raw []byte) any {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestWebStatus358ObservabilitySurvivesSDKDecode(t *testing.T) {
	var body map[string]json.RawMessage
	if err := json.Unmarshal([]byte(recordedWebStatusRunning), &body); err != nil {
		t.Fatal(err)
	}
	var additions map[string]json.RawMessage
	if err := json.Unmarshal([]byte(webStatus358Observability), &additions); err != nil {
		t.Fatal(err)
	}
	for key, value := range additions {
		body[key] = value
	}
	wire, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	fake := newWebFake(t, http.StatusOK, string(wire))
	status, err := New(fake.URL, "").WebStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(status)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatal(err)
	}
	for key, expected := range body {
		actual, ok := got[key]
		if !ok {
			t.Errorf("SDK dropped status field %q", key)
			continue
		}
		if !reflect.DeepEqual(webJSONTree(t, actual), webJSONTree(t, expected)) {
			t.Errorf("SDK changed status field %q: got %s, want %s", key, actual, expected)
		}
	}
}

func TestWebStatus358WithoutRuntimeKeepsProcessObservations(t *testing.T) {
	var body map[string]json.RawMessage
	if err := json.Unmarshal([]byte(recordedWebStatusNoListener), &body); err != nil {
		t.Fatal(err)
	}
	var observations map[string]json.RawMessage
	if err := json.Unmarshal([]byte(webStatus358Observability), &observations); err != nil {
		t.Fatal(err)
	}
	observations["ingress"] = json.RawMessage(`{"configured_listeners":0,"live_acceptors":0,"accepting_connections":false,"reason":"no_web_listener","tcp_accept_total":91,"tcp_accept_error_total":3}`)
	observations["capacity"] = json.RawMessage(`{"http_connection_capacity_action":"drop","max_http_overload_connections":4,"http_overload_timeout_ms":800,"resources":[],"saturated_resources":[],"partial":["runtime"],"rejections":[{"reason":"runtime_closed","total":2}],"http_connection_overload_outcomes":[]}`)
	observations["decoy_upstream"] = json.RawMessage(`{"outcomes":[]}`)
	delete(observations, "operator_lifecycle")
	for key, value := range observations {
		body[key] = value
	}
	wire, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	fake := newWebFake(t, http.StatusOK, string(wire))
	status, err := New(fake.URL, "").WebStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(status)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(webJSONTree(t, encoded), webJSONTree(t, wire)) {
		t.Error("unavailable runtime lost process observations or manufactured runtime/operator state")
	}
}
