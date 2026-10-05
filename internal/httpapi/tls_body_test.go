package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeTLSBodyPreservesTransportContract(t *testing.T) {
	for _, tc := range []struct {
		name, body, message string
	}{
		{"valid", `{"value":7}`, ""},
		{"empty", ``, "invalid transport request body"},
		{"malformed", `{"value":`, "invalid transport request body"},
		{"unknown", `{"other":7}`, "invalid transport request body"},
		{"multiple", `{"value":7}{}`, "one JSON object is required"},
		{"trailing junk", `{"value":7}x`, "one JSON object is required"},
		{"exact limit", `{"value":7}` + strings.Repeat(" ", (16<<10)-11), ""},
		{"oversize value", `{"value":` + strings.Repeat("1", 16<<10) + `}`, "invalid transport request body"},
		{"oversize suffix", `{"value":7}` + strings.Repeat(" ", 16<<10), "one JSON object is required"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var got struct {
				Value int `json:"value"`
			}
			w := httptest.NewRecorder()
			r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(tc.body))
			ok := decodeTLSBody(w, r, &got)
			if tc.message == "" {
				if !ok || got.Value != 7 {
					t.Fatalf("ok=%v value=%d body=%s", ok, got.Value, w.Body.String())
				}
			} else if ok || w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), tc.message) || !strings.Contains(w.Body.String(), `"code":"bad_request"`) {
				t.Fatalf("ok=%v status=%d body=%s, want bad_request %q", ok, w.Code, w.Body.String(), tc.message)
			}
		})
	}
}
