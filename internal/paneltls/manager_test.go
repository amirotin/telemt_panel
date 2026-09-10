package paneltls

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/config"
)

func testIssuer(t *testing.T) (*x509.Certificate, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	root := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "local test CA"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(365 * 24 * time.Hour), IsCA: true,
		BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature}
	der, err := x509.CreateCertificate(rand.Reader, root, root, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return cert, key
}

// fakeCA implements just the RFC 8555 exchange exercised by the real autocert
// client. Challenge validation makes an actual HTTP request to the panel handler.
type fakeCA struct {
	server            *httptest.Server
	root              *x509.Certificate
	key               *ecdsa.PrivateKey
	challengeURL      string
	mu                sync.Mutex
	authorized        bool
	issued            []byte
	orders            atomic.Int32
	certificates      atomic.Int32
	challengeRequests atomic.Int32
	nonce             atomic.Int32
	shortFirst        bool
	failRenew         bool
	failRenewAuthz    bool
	rejectIssuance    bool
	offerBrokenALPN   bool
	alpnFailed        bool
}

func newFakeCA(t *testing.T, shortFirst, failRenew bool) *fakeCA {
	t.Helper()
	root, key := testIssuer(t)
	f := &fakeCA{root: root, key: key, shortFirst: shortFirst, failRenew: failRenew}
	f.server = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeCA) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	u := f.server.URL
	w.Header().Set("Replay-Nonce", fmt.Sprintf("nonce-%d", f.nonce.Add(1)))
	w.Header().Set("Content-Type", "application/json")
	var envelope struct{ Payload string }
	var payload map[string]any
	if r.Method == http.MethodPost {
		_ = json.NewDecoder(r.Body).Decode(&envelope)
		data, _ := base64.RawURLEncoding.DecodeString(envelope.Payload)
		_ = json.Unmarshal(data, &payload)
	}
	write := func(v any) { _ = json.NewEncoder(w).Encode(v) }
	order := func() map[string]any {
		state := "pending"
		if f.authorized {
			state = "ready"
		}
		if len(f.issued) > 0 {
			state = "valid"
		}
		return map[string]any{"status": state, "identifiers": []map[string]string{{"type": "dns", "value": "panel.example.com"}},
			"authorizations": []string{u + "/authz"}, "finalize": u + "/finalize", "certificate": u + "/cert"}
	}
	switch r.URL.Path {
	case "/directory":
		write(map[string]string{"newNonce": u + "/nonce", "newAccount": u + "/account", "newOrder": u + "/order"})
	case "/nonce":
		w.WriteHeader(http.StatusNoContent)
	case "/account":
		w.Header().Set("Location", u+"/account/1")
		w.WriteHeader(http.StatusCreated)
		write(map[string]string{"status": "valid"})
	case "/order":
		if f.rejectIssuance {
			w.WriteHeader(http.StatusBadRequest)
			write(map[string]string{"type": "urn:ietf:params:acme:error:rejectedIdentifier", "detail": "test CA rejected domain"})
			return
		}
		if f.failRenew && f.certificates.Load() > 0 {
			w.Header().Set("Retry-After", "3600")
			w.WriteHeader(http.StatusTooManyRequests)
			write(map[string]string{"type": "urn:ietf:params:acme:error:rateLimited", "detail": "test renewal limit"})
			return
		}
		f.orders.Add(1)
		f.issued = nil
		if f.failRenewAuthz && f.certificates.Load() > 0 {
			f.authorized = false
		}
		f.alpnFailed = false
		w.Header().Set("Location", u+"/order/1")
		w.WriteHeader(http.StatusCreated)
		write(order())
	case "/order/1":
		write(order())
	case "/authz":
		if f.failRenewAuthz && f.certificates.Load() > 0 {
			write(map[string]any{"status": "invalid", "identifier": map[string]string{"type": "dns", "value": "panel.example.com"},
				"challenges": []map[string]any{{"type": "http-01", "status": "invalid", "url": u + "/challenge", "token": "test-token",
					"error": map[string]string{"type": "urn:ietf:params:acme:error:connection", "detail": "HTTP-01 connection refused"}}}})
			return
		}
		state := "pending"
		if f.authorized {
			state = "valid"
		}
		if f.alpnFailed {
			state = "invalid"
		}
		challenges := []map[string]string{{"type": "http-01", "url": u + "/challenge", "token": "test-token", "status": state}}
		if f.offerBrokenALPN {
			challenges = append(challenges, map[string]string{"type": "tls-alpn-01", "url": u + "/challenge-alpn", "token": "alpn-token", "status": state})
		}
		write(map[string]any{"status": state, "identifier": map[string]string{"type": "dns", "value": "panel.example.com"},
			"challenges": challenges})
	case "/challenge-alpn":
		f.alpnFailed = true
		write(map[string]string{"status": "invalid", "type": "tls-alpn-01", "url": u + "/challenge-alpn", "token": "alpn-token"})
	case "/challenge":
		req, _ := http.NewRequest(http.MethodGet, f.challengeURL+"/.well-known/acme-challenge/test-token", nil)
		req.Host = "panel.example.com"
		client := &http.Client{Timeout: 3 * time.Second}
		res, err := client.Do(req)
		if err != nil {
			http.Error(w, "challenge unreachable", 500)
			return
		}
		body, _ := io.ReadAll(res.Body)
		_ = res.Body.Close()
		if res.StatusCode != 200 || !strings.HasPrefix(string(body), "test-token.") {
			http.Error(w, "invalid HTTP-01 response", 400)
			return
		}
		f.authorized = true
		f.challengeRequests.Add(1)
		write(map[string]string{"status": "valid", "type": "http-01", "url": u + "/challenge", "token": "test-token"})
	case "/finalize":
		encoded, _ := payload["csr"].(string)
		der, err := base64.RawURLEncoding.DecodeString(encoded)
		if err != nil {
			http.Error(w, "CSR encoding", 400)
			return
		}
		csr, err := x509.ParseCertificateRequest(der)
		if err != nil || csr.CheckSignature() != nil {
			http.Error(w, "CSR signature", 400)
			return
		}
		n := f.certificates.Add(1)
		exp := time.Now().Add(90 * 24 * time.Hour)
		if n == 1 && f.shortFirst {
			exp = time.Now().Add(10 * 24 * time.Hour)
		}
		cert := &x509.Certificate{SerialNumber: big.NewInt(int64(n + 1)), DNSNames: csr.DNSNames,
			NotBefore: time.Now().Add(-90 * 24 * time.Hour), NotAfter: exp, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, KeyUsage: x509.KeyUsageDigitalSignature}
		der, err = x509.CreateCertificate(rand.Reader, cert, f.root, csr.PublicKey, f.key)
		if err != nil {
			http.Error(w, "sign", 500)
			return
		}
		f.issued = append(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: f.root.Raw})...)
		write(order())
	case "/cert":
		w.Header().Set("Content-Type", "application/pem-certificate-chain")
		_, _ = w.Write(f.issued)
	default:
		http.NotFound(w, r)
	}
}

func startManagedTLS(t *testing.T, ca *fakeCA, dir string) (*Manager, *httptest.Server, *http.Client) {
	t.Helper()
	m := New(config.TLSConfig{Mode: "acme", AcmeDomain: "panel.example.com", AcmeCacheDir: dir}, ":8443")
	m.directory = ca.server.URL + "/directory"
	tlsConfig, handler, err := m.Prepare()
	if err != nil {
		t.Fatal(err)
	}
	challenge := httptest.NewServer(handler)
	t.Cleanup(challenge.Close)
	ca.mu.Lock()
	ca.challengeURL = challenge.URL
	ca.mu.Unlock()
	s := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.TLS == nil {
			t.Error("missing TLS")
		}
		_, _ = io.WriteString(w, `{"status":"ok","version":"test"}`)
	}))
	s.TLS = tlsConfig
	s.StartTLS()
	t.Cleanup(s.Close)
	roots := x509.NewCertPool()
	roots.AddCert(ca.root)
	transport := &http.Transport{TLSClientConfig: &tls.Config{ServerName: "panel.example.com", RootCAs: roots, MinVersion: tls.VersionTLS12}}
	t.Cleanup(transport.CloseIdleConnections)
	t.Cleanup(m.Close)
	return m, s, &http.Client{Transport: transport, Timeout: 5 * time.Second}
}

func TestACMEIssueCacheRestartAndHTTP01(t *testing.T) {
	ca := newFakeCA(t, false, false)
	dir := t.TempDir()
	m, s, client := startManagedTLS(t, ca, dir)
	res, err := client.Get(s.URL)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if ca.challengeRequests.Load() != 1 || ca.certificates.Load() != 1 {
		t.Fatalf("challenge=%d certs=%d", ca.challengeRequests.Load(), ca.certificates.Load())
	}
	if st := m.Status(); st.State != "ready" || st.ExpiresAt == nil {
		t.Fatalf("status=%+v", st)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) < 2 {
		t.Fatal("account and certificate not persisted")
	}
	for _, entry := range entries {
		info, _ := entry.Info()
		if info.Mode().Perm() != 0600 {
			t.Errorf("cache mode=%v", info.Mode())
		}
	}
	m.Close()
	client.CloseIdleConnections()
	s.Close()
	m2, s2, client2 := startManagedTLS(t, ca, dir)
	ca.server.Close()
	res, err = client2.Get(s2.URL)
	if err != nil {
		t.Fatalf("restart must work without CA: %v", err)
	}
	_ = res.Body.Close()
	if m2.Status().State != "ready" || ca.certificates.Load() != 1 {
		t.Fatal("cached restart reissued certificate")
	}
}

func TestACMERenewal(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(fmt.Sprint("failure=", fail), func(t *testing.T) {
			ca := newFakeCA(t, true, fail)
			m, s, client := startManagedTLS(t, ca, t.TempDir())
			res, err := client.Get(s.URL)
			if err != nil {
				t.Fatal(err)
			}
			_ = res.Body.Close()
			deadline := time.Now().Add(5 * time.Second)
			for time.Now().Before(deadline) {
				if fail && m.Status().Stage == "ca_response" || !fail && ca.certificates.Load() >= 2 {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			if fail {
				if st := m.Status(); st.State != "warning" || !strings.Contains(st.Error, "429") {
					t.Fatalf("status=%+v", st)
				}
			} else if ca.certificates.Load() < 2 {
				t.Fatal("renewal did not run")
			}
			client.CloseIdleConnections()
			res, err = client.Get(s.URL)
			if err != nil {
				t.Fatalf("working TLS lost after renewal: %v", err)
			}
			_ = res.Body.Close()
		})
	}
}

func TestACMERenewalInvalidAuthorization(t *testing.T) {
	ca := newFakeCA(t, true, false)
	ca.failRenewAuthz = true
	m, s, client := startManagedTLS(t, ca, t.TempDir())
	res, err := client.Get(s.URL)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && m.Status().Error == "" {
		time.Sleep(10 * time.Millisecond)
	}
	st := m.Status()
	if st.State != "warning" || !strings.Contains(st.Error, "connection refused") {
		t.Fatalf("failed renewal must warn before the seven-day expiry window: %+v", st)
	}
	client.CloseIdleConnections()
	res, err = client.Get(s.URL)
	if err != nil {
		t.Fatalf("working TLS lost after invalid authorization: %v", err)
	}
	_ = res.Body.Close()
	if m.Status().Error == "" {
		t.Fatal("serving the old certificate cleared the renewal failure")
	}
}

func TestACMEProblemResponseObservation(t *testing.T) {
	for _, tt := range []struct {
		name, body, wantError string
	}{
		{"numeric status", `{"type":"urn:ietf:params:acme:error:unauthorized","detail":"account blocked","status":403}`, "account blocked"},
		{"retryable nonce", `{"type":"urn:ietf:params:acme:error:badNonce","detail":"stale nonce","status":400}`, ""},
		{"bounded body", `{"type":"urn:ietf:params:acme:error:unauthorized","detail":"` + strings.Repeat("x", 32*1024) + `"}`, ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			ca := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/problem+json")
				w.WriteHeader(http.StatusForbidden)
				_, _ = io.WriteString(w, tt.body)
			}))
			defer ca.Close()
			m := New(config.TLSConfig{Mode: "acme"}, ":8443")
			defer m.Close()
			m.certificate(&x509.Certificate{NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(30 * 24 * time.Hour)})
			client := &http.Client{Transport: &observedTransport{owner: m, next: http.DefaultTransport}}
			res, err := client.Get(ca.URL)
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(res.Body)
			_ = res.Body.Close()
			if err != nil || string(body) != tt.body {
				t.Fatal("observation changed the ACME client's response body")
			}
			st := m.Status()
			if tt.wantError == "" {
				if st.State != "ready" || st.Error != "" {
					t.Fatalf("unexpected warning: %+v", st)
				}
			} else if st.State != "warning" || !strings.Contains(st.Error, tt.wantError) {
				t.Fatalf("missing problem diagnostic: %+v", st)
			}
		})
	}
}

func TestModesAndRedirect(t *testing.T) {
	m := New(config.TLSConfig{Mode: "http"}, ":8080")
	defer m.Close()
	tc, h, err := m.Prepare()
	if err != nil || tc != nil || h != nil || m.Status().State != "http" {
		t.Fatal("HTTP unexpectedly enables TLS")
	}
	m = New(config.TLSConfig{Mode: "acme", AcmeDomain: "panel.example.com", AcmeCacheDir: t.TempDir()}, ":8443")
	defer m.Close()
	tc, h, err = m.Prepare()
	if err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		method, host string
		status       int
	}{{"GET", "panel.example.com", 302}, {"GET", "evil.example.com", 404}, {"POST", "panel.example.com", 400}} {
		r := httptest.NewRequest(tt.method, "http://"+tt.host+"/api/health?x=1", nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tt.status {
			t.Fatalf("status=%d", w.Code)
		}
		if tt.status == 302 && w.Header().Get("Location") != "https://panel.example.com:8443/api/health?x=1" {
			t.Fatal(w.Header())
		}
	}
	if _, err := tc.GetCertificate(&tls.ClientHelloInfo{ServerName: "evil.example.com"}); err == nil {
		t.Fatal("unknown SNI accepted")
	}
	if m.Status().Error != "" {
		t.Fatal("unknown SNI polluted diagnostics")
	}
	file := filepath.Join(t.TempDir(), "not-directory")
	if err := os.WriteFile(file, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	m = New(config.TLSConfig{Mode: "acme", AcmeDomain: "panel.example.com", AcmeCacheDir: file}, ":8443")
	defer m.Close()
	if _, _, err := m.Prepare(); err == nil || m.Status().Stage != "cache" {
		t.Fatal("bad cache accepted")
	}
	m = New(config.TLSConfig{Mode: "certificate", CertFile: "/does-not-exist", KeyFile: "/does-not-exist"}, ":8443")
	defer m.Close()
	if _, _, err := m.Prepare(); err == nil {
		t.Fatal("missing cert silently downgraded")
	}
}

func TestCheckHTTPDeadlineAndNoRedirect(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "http://example.com", 302) }))
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	cfg := &config.Config{Listen: strings.TrimPrefix(s.URL, "http://"), TLS: config.TLSConfig{Mode: "http"}}
	if err := Check(ctx, cfg, "test"); err == nil {
		t.Fatal("redirect accepted as readiness")
	}
}

func TestACMEIssuanceFailure(t *testing.T) {
	ca := newFakeCA(t, false, false)
	ca.rejectIssuance = true
	m, s, client := startManagedTLS(t, ca, t.TempDir())
	if res, err := client.Get(s.URL); err == nil {
		_ = res.Body.Close()
		t.Fatal("rejected certificate was accepted")
	}
	if st := m.Status(); st.State != "error" || st.Stage != "issuance" || !strings.Contains(st.Error, "rejected") {
		t.Fatalf("status=%+v", st)
	}
}

func TestCustomCertificateAndReadiness(t *testing.T) {
	root, rootKey := testIssuer(t)
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(44), DNSNames: []string{"panel.example.com"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, cert, root, &key.PublicKey, rootKey)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	certPath, keyPath := filepath.Join(dir, "fullchain.pem"), filepath.Join(dir, "key.pem")
	chain := append(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: root.Raw})...)
	if err := os.WriteFile(certPath, chain, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0600); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{TLS: config.TLSConfig{Mode: "certificate", CertFile: certPath, KeyFile: keyPath}}
	m := New(cfg.TLS, ":8443")
	defer m.Close()
	tlsConfig, h, err := m.Prepare()
	if err != nil || h != nil {
		t.Fatalf("custom TLS preparation: %v", err)
	}
	s := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"status":"ok","version":"test"}`)
	}))
	s.TLS = tlsConfig
	s.StartTLS()
	defer s.Close()
	cfg.Listen = strings.TrimPrefix(s.URL, "https://")
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := Check(ctx, cfg, "test"); err != nil {
		t.Fatal(err)
	}
	// A public-CA check must not inherit trust in a custom certificate.
	cfg.TLS = config.TLSConfig{Mode: "acme", AcmeDomain: "panel.example.com"}
	ctx2, cancel2 := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel2()
	if err := Check(ctx2, cfg, "test"); err == nil {
		t.Fatal("untrusted certificate accepted by ACME health check")
	}
}

func TestCacheFailureSurvivesCertificateObservation(t *testing.T) {
	m := New(config.TLSConfig{Mode: "acme", AcmeDomain: "panel.example.com"}, ":8443")
	defer m.Close()
	m.failure("cache", fmt.Errorf("disk full"))
	m.certificate(&x509.Certificate{DNSNames: []string{"panel.example.com"}, NotAfter: time.Now().Add(90 * 24 * time.Hour)})
	if st := m.Status(); st.State != "warning" || st.Stage != "cache" {
		t.Fatalf("lost cache failure: %+v", st)
	}
}

func TestACMEFallsBackToHTTP01(t *testing.T) {
	ca := newFakeCA(t, false, false)
	ca.offerBrokenALPN = true
	m, s, client := startManagedTLS(t, ca, t.TempDir())
	res, err := client.Get(s.URL)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if ca.orders.Load() != 2 || ca.challengeRequests.Load() != 1 || m.Status().State != "ready" {
		t.Fatalf("orders=%d HTTP challenges=%d status=%+v", ca.orders.Load(), ca.challengeRequests.Load(), m.Status())
	}
}
