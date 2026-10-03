package telemt

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"testing"
)

func TestWebSessionTelemetrySurvivesSDKDecode(t *testing.T) {
	var body map[string]json.RawMessage
	if err := json.Unmarshal([]byte(syntheticWebSessionRow), &body); err != nil {
		t.Fatal(err)
	}
	// Telemt 3.5.6 separates peer inactivity from carrier progress. Zero is
	// meaningful, and future health publication tokens must survive as well.
	body["health_publication"] = json.RawMessage(`"future_phase"`)
	body["peer_idle_ms"] = json.RawMessage(`0`)
	body["reconnect_grace_ms"] = json.RawMessage(`30000`)
	body["peer_deadline_remaining_ms"] = json.RawMessage(`0`)
	wire, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	for _, list := range []bool{false, true} {
		t.Run(map[bool]string{false: "lookup", true: "list"}[list], func(t *testing.T) {
			response := string(wire)
			if list {
				response = `{"sessions":[` + response + `],"next_cursor":null,"scanned":1,"scan_truncated":false,"partial_sessions":0,"partial":[]}`
			}
			fake := newWebFake(t, http.StatusOK, response)
			client := New(fake.URL, "")
			var row WebSessionRow
			if list {
				page, err := client.WebSessions(context.Background(), WebSessionsQuery{})
				if err != nil {
					t.Fatal(err)
				}
				if len(page.Sessions) != 1 {
					t.Fatalf("sessions = %d, want 1", len(page.Sessions))
				}
				row = page.Sessions[0]
			} else {
				result, err := client.WebSession(context.Background(), "ws1.0123456789abcdef0123456789abcdef.0000000000000001")
				if err != nil {
					t.Fatal(err)
				}
				if result.Row == nil {
					t.Fatal("live row missing")
				}
				row = *result.Row
			}
			encoded, err := json.Marshal(row)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(webJSONTree(t, encoded), webJSONTree(t, wire)) {
				t.Errorf("SDK changed session telemetry: got %s, want %s", encoded, wire)
			}
		})
	}
}

func TestWebSessionTelemetryRemainsAbsentForOlderBuilds(t *testing.T) {
	fake := newWebFake(t, http.StatusOK, syntheticWebSessionRow)
	result, err := New(fake.URL, "").WebSession(context.Background(), "ws1.0123456789abcdef0123456789abcdef.0000000000000001")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(result.Row)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(webJSONTree(t, encoded), webJSONTree(t, []byte(syntheticWebSessionRow))) {
		t.Errorf("SDK manufactured telemetry for an older build: %s", encoded)
	}
}

func TestWebSessionClosedTelemetrySurvivesSDKDecode(t *testing.T) {
	for _, body := range []string{
		`{"session_ref":"ws1.0123456789abcdef0123456789abcdef.0000000000000009","state":"closed","attempt":2}`,
		`{"session_ref":"ws1.0123456789abcdef0123456789abcdef.0000000000000009","state":"closed","attempt":2,"carrier":"future_carrier","reason":"future_reason","closed_age_ms":0}`,
	} {
		fake := newWebFake(t, http.StatusGone, body)
		result, err := New(fake.URL, "").WebSession(context.Background(), "ws1.0123456789abcdef0123456789abcdef.0000000000000009")
		if err != nil {
			t.Fatal(err)
		}
		if result.Closed == nil || result.Row != nil {
			t.Fatal("410 was not decoded as a retained closed session")
		}
		encoded, err := json.Marshal(result.Closed)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(webJSONTree(t, encoded), webJSONTree(t, []byte(body))) {
			t.Errorf("SDK changed closed-session telemetry: got %s, want %s", encoded, body)
		}
	}
}
