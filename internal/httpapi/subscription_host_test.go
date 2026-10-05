package httpapi

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
)

func TestSubscriptionURLTrustedForwardedHost(t *testing.T) {
	srv := newTestServer(t)
	srv.cfg.TrustedProxyPrefixes = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}
	srv.cfg.Subpage.Listen = "0.0.0.0:8081"
	r := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/api/users/alice/sublink", nil)
	r.RemoteAddr = "127.0.0.1:34567"
	r.Header.Set("X-Forwarded-Host", "panel.example.test")
	if got := srv.subscriptionURL(r, "/sub/test-token"); got != "http://panel.example.test:8081/sub/test-token" {
		t.Fatalf("URL=%q", got)
	}
}

func TestSubscriptionURLUsesIndependentListenerAndRejectsMalformedHost(t *testing.T) {
	srv := newTestServer(t)
	srv.cfg.TrustedProxyPrefixes = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}
	srv.cfg.Subpage.Listen = "[::]:9443"
	srv.cfg.Subpage.TLS.Mode = "manual"
	r := httptest.NewRequest(http.MethodGet, "http://internal:8080/api/users/alice/sublink", nil)
	r.RemoteAddr = "127.0.0.1:34567"
	r.Header.Set("X-Forwarded-Proto", "http")
	r.Header.Set("X-Forwarded-Host", "[2001:db8::1]:1234")
	if got := srv.subscriptionURL(r, "/custom/sub/token"); got != "https://[2001:db8::1]:9443/custom/sub/token" {
		t.Fatalf("URL=%q", got)
	}
	r.Header.Set("X-Forwarded-Host", "first.test, second.test")
	if got := srv.subscriptionURL(r, "/sub/token"); got != "" {
		t.Fatalf("malformed host generated URL=%q", got)
	}
	srv.cfg.Subpage.TLS.AcmeDomain = "subscriptions.test"
	if got := srv.subscriptionURL(r, "/sub/token"); got != "https://subscriptions.test:9443/sub/token" {
		t.Fatalf("ACME priority URL=%q", got)
	}
	srv.cfg.Subpage.PublicURL = "https://public.test"
	if got := srv.subscriptionURL(r, "/custom/sub/token"); got != "https://public.test/custom/sub/token" {
		t.Fatalf("explicit URL=%q", got)
	}
}
