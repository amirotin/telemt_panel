package httpapi

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/paneltls"
)

func TestPanelAccessExternalEditExpiryAndHTTPConfirmation(t *testing.T) {
	s, cookie, path := accessServer(t)
	candidate := config.TLSCandidate{Listen: s.cfg.Listen, TLS: config.TLSConfig{Mode: "http"}}
	w := accessRequest(t, s, cookie, "POST", "/api/settings/tls/prepare", candidate)
	var p tlsPrepared
	_ = json.Unmarshal(w.Body.Bytes(), &p)
	before, _ := os.ReadFile(path)
	changed := append(before, []byte("\n# external revision\n")...)
	_ = os.WriteFile(path, changed, 0600)
	w = accessRequest(t, s, cookie, "PUT", "/api/settings/tls/config", map[string]any{"receipt": p.Receipt, "candidate": p.Candidate})
	if w.Code != 409 {
		t.Fatalf("external edit accepted: %d %s", w.Code, w.Body.String())
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(changed, after) {
		t.Fatal("overwrote external edit")
	}
	s.access.pending.ExpiresAt = time.Now().Add(-time.Second)
	w = accessRequest(t, s, cookie, "PUT", "/api/settings/tls/config", map[string]any{"receipt": p.Receipt, "candidate": p.Candidate})
	if w.Code != 409 || !bytes.Contains(w.Body.Bytes(), []byte("tls_receipt_invalid")) {
		t.Fatal("expired receipt accepted")
	}
	candidate.Listen = "0.0.0.0:8443"
	w = accessRequest(t, s, cookie, "POST", "/api/settings/tls/prepare", candidate)
	if w.Code != 400 || !bytes.Contains(w.Body.Bytes(), []byte("confirmation_required")) {
		t.Fatal("unconfirmed public HTTP accepted")
	}
}

func TestPanelAccessConcurrentPrepareAndRequestCancellation(t *testing.T) {
	s, cookie, path := accessServer(t)
	before, _ := os.ReadFile(path)
	started := make(chan struct{})
	s.access.mux = paneltls.NewChallengeMux(http.NotFoundHandler())
	s.access.run = func(ctx context.Context, c config.TLSCandidate) ([][]byte, error) {
		if c.TLS.AcmeCacheDir != filepath.Join(filepath.Dir(path), "certs") {
			t.Error("wrong persistent default cache", c.TLS.AcmeCacheDir)
		}
		close(started)
		<-ctx.Done()
		return nil, ctx.Err()
	}
	candidate := config.TLSCandidate{Listen: s.cfg.Listen, TLS: config.TLSConfig{Mode: "acme", AcmeDomain: "panel.example"}}
	data, _ := json.Marshal(candidate)
	r := mutating("POST", "/api/settings/tls/prepare", cookie)
	r.Body = io.NopCloser(bytes.NewReader(data))
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	r = r.WithContext(ctx)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { w := httptest.NewRecorder(); s.Handler().ServeHTTP(w, r); done <- w }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("preparation did not reach injected acquisition")
	}
	w := accessRequest(t, s, cookie, "POST", "/api/settings/tls/prepare", candidate)
	if w.Code != 409 {
		t.Fatalf("concurrent preparation accepted: %d", w.Code)
	}
	cancel()
	select {
	case w = <-done:
	case <-time.After(time.Second):
		t.Fatal("preparation cancellation stalled")
	}
	if w.Code != 504 {
		t.Fatalf("canceled preparation: %d", w.Code)
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("canceled preparation changed config")
	}
	w = accessRequest(t, s, cookie, "GET", "/api/settings/tls/config", nil)
	var state tlsSettings
	_ = json.Unmarshal(w.Body.Bytes(), &state)
	if state.State != "idle" || state.Prepared != nil {
		t.Fatalf("canceled state: %+v", state)
	}
}

type accessRestartRunner struct {
	run func(context.Context, host.Op) (host.Output, error)
}

func (r accessRestartRunner) Run(ctx context.Context, op host.Op) (host.Output, error) {
	return r.run(ctx, op)
}

func TestPanelAccessRestartOnlyAfterResponseFlush(t *testing.T) {
	s, cookie, _ := accessServer(t)
	response := httptest.NewRecorder()
	called := make(chan host.Op, 1)
	s.runner = accessRestartRunner{run: func(_ context.Context, op host.Op) (host.Output, error) {
		if !response.Flushed || response.Code != 202 || !bytes.Contains(response.Body.Bytes(), []byte("new_url")) {
			t.Error("restart started before response delivery")
		}
		called <- op
		return host.Output{}, errors.New("restart unavailable")
	}}
	candidate := config.TLSCandidate{Listen: s.cfg.Listen, TLS: config.TLSConfig{Mode: "http"}}
	w := accessRequest(t, s, cookie, "POST", "/api/settings/tls/prepare", candidate)
	var p tlsPrepared
	_ = json.Unmarshal(w.Body.Bytes(), &p)
	w = accessRequest(t, s, cookie, "PUT", "/api/settings/tls/config", map[string]any{"receipt": p.Receipt, "candidate": p.Candidate})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	s.Handler().ServeHTTP(response, mutating("POST", "/api/settings/tls/restart", cookie))
	select {
	case op := <-called:
		if op.Kind != host.OpRestartService || op.Args[host.ArgService] != "test-panel" {
			t.Fatalf("wrong allowlisted operation: %+v", op)
		}
	case <-time.After(time.Second):
		t.Fatal("restart not invoked")
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		s.access.mu.Lock()
		state := s.access.state
		s.access.mu.Unlock()
		if state == "restart_failed" {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("restart failure not exposed")
}

func TestPanelAccessReadOnlyConfigurationNeverPrepares(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can write a mode0400 file")
	}
	s, cookie, path := accessServer(t)
	if err := os.Chmod(path, 0400); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(path)
	w := accessRequest(t, s, cookie, "GET", "/api/settings/tls/config", nil)
	var state tlsSettings
	_ = json.Unmarshal(w.Body.Bytes(), &state)
	if state.Capabilities.ConfigWritable || state.Capabilities.Prepare {
		t.Fatal("read-only configuration advertised as writable")
	}
	w = accessRequest(t, s, cookie, "POST", "/api/settings/tls/prepare", config.TLSCandidate{Listen: s.cfg.Listen, TLS: config.TLSConfig{Mode: "http"}})
	if w.Code != 503 {
		t.Fatal("read-only configuration accepted preparation")
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("read-only configuration changed")
	}
}

func TestPanelAccessMissingPreparedKeyDoesNotSave(t *testing.T) {
	s, cookie, path := accessServer(t)
	fixture := httptest.NewTLSServer(http.NotFoundHandler())
	defer fixture.Close()
	cert := fixture.TLS.Certificates[0]
	template := &x509.Certificate{SerialNumber: big.NewInt(1), DNSNames: []string{"panel.example"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, KeyUsage: x509.KeyUsageDigitalSignature}
	der, err := x509.CreateCertificate(rand.Reader, template, template, cert.PrivateKey.(crypto.Signer).Public(), cert.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	key, err := x509.MarshalPKCS8PrivateKey(cert.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	certPath, keyPath := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	_ = os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600)
	_ = os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}), 0600)
	candidate := config.TLSCandidate{Listen: s.cfg.Listen, TLS: config.TLSConfig{Mode: "certificate", CertFile: certPath, KeyFile: keyPath}}
	w := accessRequest(t, s, cookie, "POST", "/api/settings/tls/prepare", candidate)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var p tlsPrepared
	_ = json.Unmarshal(w.Body.Bytes(), &p)
	before, _ := os.ReadFile(path)
	_ = os.Remove(keyPath)
	w = accessRequest(t, s, cookie, "PUT", "/api/settings/tls/config", map[string]any{"receipt": p.Receipt, "candidate": p.Candidate})
	if w.Code < 400 {
		t.Fatal("configuration saved after prepared key disappeared")
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("missing prepared key changed configuration")
	}
}
