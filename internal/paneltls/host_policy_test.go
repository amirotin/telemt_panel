package paneltls

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"golang.org/x/crypto/acme/autocert"
)

func TestACMEHostPolicyCanonicalHTTPHost(t *testing.T) {
	policy := acmeHostPolicy("panel.example.com")
	for _, host := range []string{"panel.example.com", "panel.example.com:80", "PANEL.EXAMPLE.COM:80", "panel.example.com.", "panel.example.com.:80"} {
		if err := policy(context.Background(), host); err != nil {
			t.Errorf("valid host %q: %v", host, err)
		}
	}
	for _, host := range []string{"", "evil.example", "panel.example.com.evil", "panel.example.com:443", "panel.example.com:", "panel.example.com:bad", "panel.example.com:80:80", "panel.example.com@evil.example", "[panel.example.com]:80", "127.0.0.1:80"} {
		if err := policy(context.Background(), host); err == nil {
			t.Errorf("foreign or malformed host accepted: %q", host)
		}
	}
}

func TestHTTP01ExplicitPortReachesTokenLookup(t *testing.T) {
	manager := &autocert.Manager{HostPolicy: acmeHostPolicy("panel.example.com")}
	handler := manager.HTTPHandler(nil)
	for _, host := range []string{"panel.example.com", "panel.example.com:80"} {
		req := httptest.NewRequest(http.MethodGet, "http://"+host+"/.well-known/acme-challenge/missing", nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		if response.Code != http.StatusNotFound {
			t.Fatalf("host %q rejected before token lookup: %d", host, response.Code)
		}
	}
}
