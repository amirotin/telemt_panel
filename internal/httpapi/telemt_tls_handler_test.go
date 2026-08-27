package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/amirotin/telemt_panel/internal/telemt"
	"github.com/amirotin/telemt_panel/internal/telemt/telemttest"
)

// TestHandleGetTelemtTLSFingerprints_Passthrough covers the fetch-on-visit
// replacement for the "security" topic's former tls_fingerprints field: a
// straight passthrough of telemt.TLSFingerprints with runtime_edge on.
func TestHandleGetTelemtTLSFingerprints_Passthrough(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{RuntimeEdge: true})

	w := doRequest(t, srv, cookie, "GET", "/api/telemt/tls-fingerprints", nil, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	var got telemt.Gated[telemt.RuntimeEdgeTLSFingerprintsPayload]
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !got.Enabled || got.Data == nil {
		t.Fatalf("gated payload = %+v, want enabled with data", got)
	}
	if len(got.Data.ByFingerprint) == 0 {
		t.Errorf("by_fingerprint is empty: %+v", got.Data)
	}
}

// TestHandleGetTelemtTLSFingerprints_LimitForwarded proves the ?limit=
// query parameter reaches Telemt (the panel's own default of 50 when it is
// absent, the admin's value when present).
func TestHandleGetTelemtTLSFingerprints_LimitForwarded(t *testing.T) {
	var seen []string
	fake := telemttest.New(telemttest.Scenario{RuntimeEdge: true})
	t.Cleanup(fake.Close)
	recorder := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/runtime/tls-fingerprints" {
			seen = append(seen, r.URL.RawQuery)
		}
		http.Redirect(w, r, fake.URL+r.URL.RequestURI(), http.StatusTemporaryRedirect)
	}))
	t.Cleanup(recorder.Close)

	tc := telemt.New(recorder.URL, "")
	srv, cookie := newTelemtInfoTestServer(t, tc)

	if w := doRequest(t, srv, cookie, "GET", "/api/telemt/tls-fingerprints", nil, nil); w.Code != http.StatusOK {
		t.Fatalf("default limit: status = %d, want 200: %s", w.Code, w.Body)
	}
	if w := doRequest(t, srv, cookie, "GET", "/api/telemt/tls-fingerprints?limit=7", nil, nil); w.Code != http.StatusOK {
		t.Fatalf("explicit limit: status = %d, want 200: %s", w.Code, w.Body)
	}
	if len(seen) != 2 || seen[0] != "limit=50" || seen[1] != "limit=7" {
		t.Errorf("forwarded queries = %v, want [limit=50 limit=7]", seen)
	}
}

// TestHandleGetTelemtTLSFingerprints_BadLimit covers the panel-side
// validation: 1..500, integers only, rejected before Telemt is touched.
func TestHandleGetTelemtTLSFingerprints_BadLimit(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{RuntimeEdge: true})

	for _, raw := range []string{"0", "-1", "501", "abc", "1.5", ""} {
		w := doRequest(t, srv, cookie, "GET", "/api/telemt/tls-fingerprints?limit="+raw, nil, nil)
		if raw == "" {
			// An empty value is "not supplied" — the default applies.
			if w.Code != http.StatusOK {
				t.Errorf("limit=%q: status = %d, want 200", raw, w.Code)
			}
			continue
		}
		if w.Code != http.StatusBadRequest {
			t.Errorf("limit=%q: status = %d, want 400: %s", raw, w.Code, w.Body)
			continue
		}
		var errBody struct{ Code string }
		if err := json.Unmarshal(w.Body.Bytes(), &errBody); err != nil {
			t.Fatalf("decode error body: %v", err)
		}
		if errBody.Code != "bad_request" {
			t.Errorf("limit=%q: code = %q, want bad_request", raw, errBody.Code)
		}
	}
}

// TestHandleGetTelemtTLSFingerprints_CapabilityGate covers the
// runtime_edge-off path: Telemt answers enabled:false, which the handler
// maps to the same 503 capability_unavailable code the config API's own
// gate uses — the frontend renders that as its Gated hint, not an error.
func TestHandleGetTelemtTLSFingerprints_CapabilityGate(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})

	w := doRequest(t, srv, cookie, "GET", "/api/telemt/tls-fingerprints", nil, nil)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: %s", w.Code, w.Body)
	}
	var errBody struct{ Code string }
	if err := json.Unmarshal(w.Body.Bytes(), &errBody); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if errBody.Code != "capability_unavailable" {
		t.Errorf("code = %q, want capability_unavailable", errBody.Code)
	}
}

// TestHandleGetTelemtTLSFingerprints_CapabilityAbsent covers an old build
// that never registered the route: a bare 404 must surface as 501
// capability_absent, not 502 — writeTelemtError's capabilityGated branch.
func TestHandleGetTelemtTLSFingerprints_CapabilityAbsent(t *testing.T) {
	fake := httptest.NewServer(http.HandlerFunc(http.NotFound))
	t.Cleanup(fake.Close)

	srv, cookie := newTelemtInfoTestServer(t, telemt.New(fake.URL, ""))
	w := doRequest(t, srv, cookie, "GET", "/api/telemt/tls-fingerprints", nil, nil)
	if w.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501: %s", w.Code, w.Body)
	}
	var errBody struct{ Code string }
	if err := json.Unmarshal(w.Body.Bytes(), &errBody); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if errBody.Code != "capability_absent" {
		t.Errorf("code = %q, want capability_absent", errBody.Code)
	}
}

// TestHandleGetTelemtTLSFingerprints_Unreachable covers the 502
// telemt_unreachable path — a dial failure never decodes as *telemt.APIError,
// so it must never be confused with the runtime_edge gate being off.
func TestHandleGetTelemtTLSFingerprints_Unreachable(t *testing.T) {
	srv, cookie := newTelemtInfoTestServer(t, telemt.New("http://127.0.0.1:1", ""))

	w := doRequest(t, srv, cookie, "GET", "/api/telemt/tls-fingerprints", nil, nil)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502: %s", w.Code, w.Body)
	}
}

// TestHandleGetTelemtTLSFingerprints_RequiresAuth pins the RequireAuth
// wrapper: no session, no data.
func TestHandleGetTelemtTLSFingerprints_RequiresAuth(t *testing.T) {
	srv, _, _ := newTelemttestConfigServer(t, telemttest.Scenario{RuntimeEdge: true})

	r := httptest.NewRequest("GET", "/api/telemt/tls-fingerprints", nil)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401: %s", w.Code, w.Body)
	}
}
