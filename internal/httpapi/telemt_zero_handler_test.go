package httpapi

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/amirotin/telemt_panel/internal/telemt"
	"github.com/amirotin/telemt_panel/internal/telemt/telemttest"
)

// TestHandleGetTelemtZero_Passthrough covers the web frontend's "Диагностика →
// Счётчики" data source: a straight passthrough of telemt.ZeroAll.
func TestHandleGetTelemtZero_Passthrough(t *testing.T) {
	srv, cookie, _ := newTelemttestConfigServer(t, telemttest.Scenario{})

	w := doRequest(t, srv, cookie, "GET", "/api/telemt/zero", nil, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	var got telemt.ZeroAllData
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Core) == 0 || len(got.Upstream) == 0 || len(got.MiddleProxy) == 0 ||
		len(got.Pool) == 0 || len(got.Desync) == 0 {
		t.Errorf("ZeroAllData sections should not be empty: %+v", got)
	}
}

// TestHandleGetTelemtZero_Unreachable covers the 502 telemt_unreachable path
// when Telemt cannot be reached at all (not a capability question).
func TestHandleGetTelemtZero_Unreachable(t *testing.T) {
	tc := telemt.New("http://127.0.0.1:1", "")
	srv, cookie := newTelemtInfoTestServer(t, tc)

	w := doRequest(t, srv, cookie, "GET", "/api/telemt/zero", nil, nil)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502: %s", w.Code, w.Body)
	}
}
