package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStrictBasePathKeepsAPISemanticsOnlyBehindPrefix(t *testing.T) {
	server := newTestServer(t)
	server.cfg.BasePath = "/panel"
	for _, webUI := range []bool{true, false} {
		if !webUI {
			server.webUI = nil
		}
		handler := server.Handler()
		for _, prefix := range []string{"", "/panel"} {
			for _, test := range []struct {
				method, path string
				status       int
			}{
				{http.MethodGet, "/api/health", 200},
				{http.MethodGet, "/api/auth/me", 401},
				{http.MethodGet, "/api/unknown", 404},
				{http.MethodPost, "/api/health", 405},
			} {
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, httptest.NewRequest(test.method, prefix+test.path, nil))
				if prefix == "" {
					if response.Code != 404 || response.Header().Get("Location") != "" {
						t.Errorf("unprefixed route exposed: %s", test.path)
					}
					continue
				}
				if response.Code != test.status {
					t.Errorf("webUI=%v %s %s: got %d, want %d", webUI, test.method, prefix+test.path, response.Code, test.status)
				}
				if response.Header().Get("Content-Type") != "application/json" {
					t.Errorf("API escaped to SPA: %s", prefix+test.path)
				}
			}
		}
	}
}

func TestBasePathStripsOnlyOneWholePrefix(t *testing.T) {
	for _, test := range []struct{ input, want string }{
		{"/panel/api/health", "/api/health"},
		{"/api/health", "/api/health"},
		{"/panelish/api/health", "/panelish/api/health"},
		{"/panel/panel/api/health", "/panel/api/health"},
	} {
		handler := acceptBasePath("/panel", http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
			if r.URL.Path != test.want || r.URL.RawQuery != "page=2" {
				t.Errorf("%s became %s?%s", test.input, r.URL.Path, r.URL.RawQuery)
			}
		}))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", test.input+"?page=2", nil))
		if test.input == "/api/health" || test.input == "/panelish/api/health" {
			if response.Code != 404 {
				t.Errorf("prefix bypass: %s", test.input)
			}
		}
	}
}
