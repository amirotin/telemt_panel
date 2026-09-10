package paneltls

import (
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/config"
)

func TestFirstCertificateObservationPreservesConcurrentRenewalFailure(t *testing.T) {
	m := New(config.TLSConfig{Mode: "acme", AcmeDomain: "panel.example.com"}, ":8443")
	defer m.Close()
	// autocert may start renewal before the initial GetCertificate returns.
	m.failure("ca_response", errors.New("CA HTTP 429"))
	m.certificate(&x509.Certificate{DNSNames: []string{"panel.example.com"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(10 * 24 * time.Hour)})
	if status := m.Status(); status.Stage != "ca_response" || status.State != "warning" {
		t.Fatalf("initial certificate observation erased renewal failure: %+v", status)
	}
}

type observationTransport struct{ body io.ReadCloser }

func (tr observationTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/pem-certificate-chain"}}, Body: tr.body}, nil
}

func TestCertificateResponseMarkerRequiresCompleteMatchingPEM(t *testing.T) {
	root, key := testIssuer(t)
	template := &x509.Certificate{SerialNumber: big.NewInt(8), DNSNames: []string{"panel.example.com"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(90 * 24 * time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, template, root, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	encoded := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	for _, tc := range []struct {
		name, body     string
		consume, ready bool
	}{
		{"complete", encoded, true, true}, {"unread", encoded, false, false}, {"truncated", encoded[:len(encoded)-12], true, false}, {"broken-tail", encoded + "-----BEGIN CERTIFICATE-----\ninvalid", true, false}, {"late-renewal", encoded, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := New(config.TLSConfig{Mode: "acme", AcmeDomain: "panel.example.com"}, ":8443")
			defer m.Close()
			m.failure("ca_response", errors.New("failed ALPN authorization"))
			tr := observedTransport{owner: m, next: observationTransport{body: io.NopCloser(strings.NewReader(tc.body))}}
			req, _ := http.NewRequest("POST", "http://local-ca.invalid/cert", nil)
			response, err := tr.RoundTrip(req)
			if err != nil {
				t.Fatal(err)
			}
			if tc.consume {
				_, _ = io.ReadAll(response.Body)
			}
			if tc.name == "late-renewal" {
				m.failure("ca_response", errors.New("later renewal429"))
			}
			_ = response.Body.Close()
			m.certificate(cert)
			if got := m.Status().State == "ready"; got != tc.ready {
				t.Fatalf("ready=%v want %v; incomplete certificate response changed diagnostics", got, tc.ready)
			}
		})
	}
}

func TestSuccessfulAcquisitionClearsOlderFailure(t *testing.T) {
	ca := newFakeCA(t, false, false)
	m, s, client := startManagedTLS(t, ca, t.TempDir())
	m.failure("issuance", errors.New("prior acquisition failed"))
	response, err := client.Get(s.URL)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if status := m.Status(); status.State != "ready" || status.Error != "" {
		t.Fatalf("successful retry retained stale failure: %+v", status)
	}
	m.failure("ca_response", errors.New("renewal failed"))
	client.CloseIdleConnections()
	response, err = client.Get(s.URL)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if status := m.Status(); status.Stage != "ca_response" || status.State != "warning" {
		t.Fatalf("cached handshake cleared renewal failure: %+v", status)
	}
}

func TestLateCertificateObservationCannotReplaceRenewedCertificate(t *testing.T) {
	m := New(config.TLSConfig{Mode: "acme", AcmeDomain: "panel.example.com"}, ":8443")
	defer m.Close()
	newExpiry := time.Now().Add(90 * 24 * time.Hour)
	m.certificate(&x509.Certificate{DNSNames: []string{"panel.example.com"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: newExpiry})
	m.failure("ca_response", errors.New("newer renewal failed"))
	m.certificate(&x509.Certificate{DNSNames: []string{"panel.example.com"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(10 * 24 * time.Hour)})
	if status := m.Status(); status.ExpiresAt == nil || !status.ExpiresAt.Equal(newExpiry) || status.Stage != "ca_response" {
		t.Fatalf("late observation replaced renewed certificate: %+v", status)
	}
}

func TestSameExpiryReplacementClearsOnlyItsResolvedWarning(t *testing.T) {
	root, key := testIssuer(t)
	expiry := time.Now().Add(90 * 24 * time.Hour).Truncate(time.Second)
	issue := func(serial int64) *x509.Certificate {
		template := &x509.Certificate{SerialNumber: big.NewInt(serial), DNSNames: []string{"panel.example.com"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: expiry}
		der, err := x509.CreateCertificate(rand.Reader, template, root, &key.PublicKey, key)
		if err != nil {
			t.Fatal(err)
		}
		cert, err := x509.ParseCertificate(der)
		if err != nil {
			t.Fatal(err)
		}
		return cert
	}
	old, replacement := issue(21), issue(22)
	m := New(config.TLSConfig{Mode: "acme", AcmeDomain: "panel.example.com"}, ":8443")
	defer m.Close()
	m.certificate(old)
	m.failure("ca_response", errors.New("authorization failed before replacement"))
	m.observeIssuedCertificate(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: replacement.Raw}))
	m.certificate(replacement)
	if status := m.Status(); status.State != "ready" || status.Error != "" {
		t.Fatalf("equal-expiry issued replacement retained old warning: %+v", status)
	}
	m.failure("ca_response", errors.New("newer renewal failed"))
	m.certificate(replacement)
	if status := m.Status(); status.State != "warning" {
		t.Fatalf("equal-expiry observation cleared newer failure: %+v", status)
	}
	m.failure("cache", errors.New("cache failed"))
	m.observeIssuedCertificate(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: replacement.Raw}))
	m.certificate(replacement)
	if status := m.Status(); status.Stage != "cache" {
		t.Fatal("cache failure cleared")
	}
}
