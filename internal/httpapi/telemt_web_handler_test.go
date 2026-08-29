package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
	"github.com/amirotin/telemt_panel/internal/telemt/telemttest"
)

func decodeWebJSON[T any](t *testing.T, body []byte) T {
	t.Helper()
	var out T
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
	return out
}

func TestHandleGetTelemtWebSessions_Passthrough(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})

	w := doRequest(t, srv, cookie, "GET", "/api/telemt/web/sessions?limit=5&carrier=websocket", nil, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	page := decodeWebJSON[telemt.WebSessionPage](t, w.Body.Bytes())
	if len(page.Sessions) == 0 {
		t.Fatalf("no sessions came back: %s", w.Body)
	}
	for _, row := range page.Sessions {
		if row.Carrier != "websocket" {
			t.Errorf("filter not forwarded: row carrier = %q", row.Carrier)
		}
	}
}

// The query whitelist is the panel's own, checked BEFORE the request is
// forwarded: an unknown or repeated field is a 400 here, not a passthrough
// of Telemt's.
func TestHandleGetTelemtWebSessions_RejectsAnythingOffTheWhitelist(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})

	for _, query := range []string{
		"?bogus=1",
		"?user=a&user=b",
		"?limit=0",
		"?limit=201",
		"?limit=abc",
		"?LIMIT=5",
		// An EMPTY value is a 400 on Telemt 3.5.5 for every one of the ten
		// names (verified against the running binary). Dropping it silently
		// — which WebSessionsQuery.encode() would do — turns a filter the
		// operator set into a full unfiltered page answered with 200.
		"?host=",
		"?limit=",
		"?cursor=",
		"?state=",
		"?ip=",
		"?user=",
		"?key_id=",
		"?carrier=",
		"?user_agent_id=",
		"?session_ref=",
		// session_ref is a point lookup Telemt rewrites into a one-row
		// window, so it cannot carry a paging window of its own.
		"?session_ref=ws1.0123456789abcdef0123456789abcdef.0000000000000001&limit=5",
		"?session_ref=ws1.0123456789abcdef0123456789abcdef.0000000000000001&cursor=ws1.0123456789abcdef0123456789abcdef.0000000000000002",
	} {
		w := doRequest(t, srv, cookie, "GET", "/api/telemt/web/sessions"+query, nil, nil)
		if w.Code != http.StatusBadRequest {
			t.Errorf("GET %s = %d, want 400: %s", query, w.Code, w.Body)
		}
	}

	// …and every whitelisted name is accepted, so the guard cannot pass by
	// rejecting everything.
	accepted := "?limit=3&cursor=ws1.0123456789abcdef0123456789abcdef.0000000000000001" +
		"&ip=203.0.113.11&host=proxy.example.com&user=web-user" +
		"&user_agent_id=00000000000000000000000000000b201&key_id=000000000000a101" +
		"&carrier=https-lanes&state=healthy"
	if w := doRequest(t, srv, cookie, "GET", "/api/telemt/web/sessions"+accepted, nil, nil); w.Code != http.StatusOK {
		t.Errorf("the full whitelist was rejected: %d %s", w.Code, w.Body)
	}
}

func TestHandleGetTelemtWebSession_RowAndTombstone(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})

	page := decodeWebJSON[telemt.WebSessionPage](t,
		doRequest(t, srv, cookie, "GET", "/api/telemt/web/sessions?limit=1", nil, nil).Body.Bytes())
	ref := page.Sessions[0].SessionRef

	w := doRequest(t, srv, cookie, "GET", "/api/telemt/web/sessions/"+ref, nil, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	got := decodeWebJSON[telemt.WebSessionResult](t, w.Body.Bytes())
	if got.Row == nil || got.Closed != nil {
		t.Fatalf("got %+v, want a live row", got)
	}

	// Close it, then look it up again: a tombstone is still HTTP 200 here,
	// with `closed` set — the browser must not see "session gone" as a
	// failed request.
	body := []byte(`{"runtime_instance":"0123456789abcdef0123456789abcdef","selector":{"kind":"refs","session_refs":["` + ref + `"]}}`)
	if w := doRequest(t, srv, cookie, "POST", "/api/telemt/web/sessions/close", nil, body); w.Code != http.StatusAccepted {
		t.Fatalf("close status = %d, want 202: %s", w.Code, w.Body)
	}

	w = doRequest(t, srv, cookie, "GET", "/api/telemt/web/sessions/"+ref, nil, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("tombstone status = %d, want 200: %s", w.Code, w.Body)
	}
	got = decodeWebJSON[telemt.WebSessionResult](t, w.Body.Bytes())
	if got.Row != nil || got.Closed == nil || got.Closed.State != "closed" {
		t.Fatalf("got %+v, want a tombstone", got)
	}
}

func TestHandleGetTelemtWebSession_NotFoundKeepsItsOwnCode(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})

	w := doRequest(t, srv, cookie, "GET",
		"/api/telemt/web/sessions/ws1.0123456789abcdef0123456789abcdef.00000000000000ff", nil, nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404: %s", w.Code, w.Body)
	}
	if !strings.Contains(w.Body.String(), telemt.CodeWebSessionNotFound) {
		t.Errorf("body = %s, want %s", w.Body, telemt.CodeWebSessionNotFound)
	}
}

func TestHandlePostTelemtWebSessionsClose_AuditAndOperation(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})

	body := []byte(`{"runtime_instance":"0123456789abcdef0123456789abcdef","selector":{"kind":"filter","carrier":"websocket"}}`)
	w := doRequest(t, srv, cookie, "POST", "/api/telemt/web/sessions/close", nil, body)
	if w.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202: %s", w.Code, w.Body)
	}
	op := decodeWebJSON[telemt.WebControlOperationStatus](t, w.Body.Bytes())
	if op.OperationID == "" || op.State != telemt.WebOperationQueued {
		t.Fatalf("operation = %+v", op)
	}

	// The poll route reports the terminal state.
	w = doRequest(t, srv, cookie, "GET", "/api/telemt/web/operations/"+op.OperationID, nil, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("poll status = %d, want 200: %s", w.Code, w.Body)
	}
	done := decodeWebJSON[telemt.WebControlOperationStatus](t, w.Body.Bytes())
	if !telemt.IsWebOperationTerminal(done.State) || done.CloseSignalled == 0 {
		t.Fatalf("polled operation = %+v, want a terminal close", done)
	}

	// The journal records WHAT was closed, with the operation id, so the
	// entry stays traceable to Telemt's own operation.
	entries, err := srv.st.ListAudit(10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	var found *store.AuditEntry
	for i := range entries {
		if entries[i].Action == "web.sessions.close" {
			found = &entries[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("no web.sessions.close audit entry: %+v", entries)
	}
	if found.Subject != "filter" {
		t.Errorf("audit subject = %q, want the selector kind", found.Subject)
	}
	if !strings.Contains(found.Detail, "operation="+op.OperationID) || !strings.Contains(found.Detail, "carrier=websocket") {
		t.Errorf("audit detail = %q, want the operation id and the selector", found.Detail)
	}
}

func TestHandlePostTelemtWebSessionsClose_RejectsAMalformedBody(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})

	for name, body := range map[string]string{
		"no runtime_instance": `{"selector":{"kind":"all"}}`,
		"unknown selector":    `{"runtime_instance":"0123456789abcdef0123456789abcdef","selector":{"kind":"everything"}}`,
		"no selector":         `{"runtime_instance":"0123456789abcdef0123456789abcdef"}`,
		"unknown field":       `{"runtime_instance":"0123456789abcdef0123456789abcdef","selector":{"kind":"all"},"force":true}`,
		"not json":            `nope`,
	} {
		w := doRequest(t, srv, cookie, "POST", "/api/telemt/web/sessions/close", nil, []byte(body))
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400: %s", name, w.Code, w.Body)
		}
	}
}

// The close-all guard and the process fence are Telemt's, forwarded with
// their own 409 codes rather than flattened into a generic failure.
func TestHandlePostTelemtWebSessionsClose_ConflictCodesSurvive(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})

	for _, tc := range []struct {
		name string
		body string
		code string
	}{
		{"close-all while issuance is on", `{"runtime_instance":"0123456789abcdef0123456789abcdef","selector":{"kind":"all"}}`, telemt.CodeWebIssuanceEnabled},
		{"a fence from another process", `{"runtime_instance":"ffffffffffffffffffffffffffffffff","selector":{"kind":"filter","user":"web-user"}}`, telemt.CodeWebRuntimeMismatch},
	} {
		w := doRequest(t, srv, cookie, "POST", "/api/telemt/web/sessions/close", nil, []byte(tc.body))
		if w.Code != http.StatusConflict {
			t.Errorf("%s: status = %d, want 409: %s", tc.name, w.Code, w.Body)
		}
		if !strings.Contains(w.Body.String(), tc.code) {
			t.Errorf("%s: body = %s, want %s", tc.name, w.Body, tc.code)
		}
	}
}

// Telemt's own read_only mode is the panel's read-only mode for this route:
// the mutation is refused with 403, not attempted.
func TestHandlePostTelemtWebSessionsClose_ReadOnly(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{ReadOnly: true})

	body := []byte(`{"runtime_instance":"0123456789abcdef0123456789abcdef","selector":{"kind":"filter","user":"web-user"}}`)
	w := doRequest(t, srv, cookie, "POST", "/api/telemt/web/sessions/close", nil, body)
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403: %s", w.Code, w.Body)
	}
	if !strings.Contains(w.Body.String(), "read_only") {
		t.Errorf("body = %s, want read_only", w.Body)
	}
}

// R5, both halves: a WEB runtime that is off is a GATE (503
// capability_unavailable, the code the UI renders as a Gated hint), while a
// build that predates the routes is UNSUPPORTED (501 capability_absent).
func TestWebRoutesSplitDisabledFromUnsupported(t *testing.T) {
	paths := []string{
		"/api/telemt/web/sessions",
		"/api/telemt/web/sessions/ws1.0123456789abcdef0123456789abcdef.0000000000000001",
		"/api/telemt/web/operations/wo1.0123456789abcdef0123456789abcdef.0000000000000001",
	}

	offSrv, offCookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{WebOff: true})
	for _, path := range paths {
		w := doRequest(t, offSrv, offCookie, "GET", path, nil, nil)
		if w.Code != http.StatusServiceUnavailable {
			t.Errorf("web-off GET %s = %d, want 503: %s", path, w.Code, w.Body)
		}
		if !strings.Contains(w.Body.String(), "capability_unavailable") {
			t.Errorf("web-off GET %s body = %s, want capability_unavailable", path, w.Body)
		}
	}

	oldSrv, oldCookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{OldBuild: true})
	for _, path := range paths {
		w := doRequest(t, oldSrv, oldCookie, "GET", path, nil, nil)
		if w.Code != http.StatusNotImplemented {
			t.Errorf("old-build GET %s = %d, want 501: %s", path, w.Code, w.Body)
		}
		if !strings.Contains(w.Body.String(), "capability_absent") {
			t.Errorf("old-build GET %s body = %s, want capability_absent", path, w.Body)
		}
	}
}

// The two Telemt mutations the panel deliberately does NOT expose
// (Panvex's half of the boundary). A future refactor that "helpfully"
// proxies the whole /v1/runtime/web/ prefix would light this up.
func TestWebDebugAndLearningMutationsAreNotExposed(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})

	for _, path := range []string{
		"/api/telemt/web/debug/clear",
		"/api/telemt/web/carrier-learning/reset",
	} {
		w := doRequest(t, srv, cookie, "POST", path, nil, []byte(`{}`))
		if w.Code == http.StatusOK || w.Code == http.StatusAccepted {
			t.Errorf("POST %s = %d — this route must not exist on the panel", path, w.Code)
		}
	}
}
