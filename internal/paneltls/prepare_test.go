package paneltls

import (
	"context"
	"crypto/x509"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/config"
	"golang.org/x/crypto/acme/autocert"
)

func TestChallengeMuxPreservesActiveTokenAndOrdinaryRequests(t *testing.T) {
	active := &autocert.Manager{Cache: autocert.DirCache(t.TempDir())}
	active.HTTPHandler(nil)
	// Cache writes here model autocert's actual HTTP-01 cache seam.
	_ = active.Cache.Put(context.Background(), "old+http-01", []byte("old-token"))
	candidate := &autocert.Manager{Cache: autocert.DirCache(t.TempDir())}
	_ = candidate.Cache.Put(context.Background(), "new+http-01", []byte("new-token"))
	mux := NewChallengeMux(active.HTTPHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(418) })))
	remove, err := mux.Install("panel.example", candidate.HTTPHandler(http.NotFoundHandler()))
	if err != nil {
		t.Fatal(err)
	}
	defer remove()
	for _, tc := range []struct {
		path string
		code int
		body string
	}{{"/.well-known/acme-challenge/old", 200, "old-token"}, {"/.well-known/acme-challenge/new", 200, "new-token"}, {"/api/auth/login", 418, ""}} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("GET", "http://panel.example"+tc.path, nil)
		mux.ServeHTTP(w, r)
		if w.Code != tc.code || w.Body.String() != tc.body {
			t.Fatalf("%s: %d %q", tc.path, w.Code, w.Body.String())
		}
	}
}

func TestPreparationListenerConflictAndCancellation(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	c := config.TLSCandidate{Listen: ln.Addr().String(), TLS: config.TLSConfig{Mode: "http"}}
	if _, err := PrepareCandidate(context.Background(), c, "127.0.0.1:1", nil, nil); err == nil {
		t.Fatal("conflicting listener accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := PrepareCandidate(ctx, c, c.Listen, nil, nil); err == nil {
		t.Fatal("cancellation ignored")
	}
}

func TestCandidateCertificateTrustRequiresActualChain(t *testing.T) {
	root, _ := testIssuer(t)
	if _, err := verifyChain([][]byte{root.Raw}, "panel.example", true, nil); err == nil {
		t.Fatal("CA certificate accepted as panel leaf")
	}
	pool := x509.NewCertPool()
	pool.AddCert(root)
	if _, err := verifyChain(nil, "panel.example", true, pool); err == nil {
		t.Fatal("missing certificate accepted")
	}
}

func TestCandidateChallengeCleanupOnCanceledAcquisition(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	mux := NewChallengeMux(nil)
	_, err = prepareCandidate(ctx, config.TLSCandidate{Listen: "127.0.0.1:8443", TLS: config.TLSConfig{Mode: "acme", AcmeDomain: "panel.example", AcmeCacheDir: t.TempDir()}}, "127.0.0.1:8443", mux, func(ctx context.Context, _ config.TLSCandidate) ([][]byte, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}, addr)
	if err == nil {
		t.Fatal("canceled preparation succeeded")
	}
	rebound, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatalf("challenge listener leaked: %v", err)
	}
	rebound.Close()
	remove, err := mux.Install("panel.example", http.NotFoundHandler())
	if err != nil {
		t.Fatal("candidate handler leaked", err)
	}
	remove()
}

func TestCandidateCertificateRejectsNonRegularInputWithoutBlocking(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fifo.pem")
	if err := syscall.Mkfifo(path, 0600); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := PrepareCandidate(context.Background(), config.TLSCandidate{Listen: "127.0.0.1:8443", TLS: config.TLSConfig{Mode: "certificate", CertFile: path, KeyFile: path}}, "127.0.0.1:8443", nil, nil)
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("FIFO certificate accepted")
		}
	case <-time.After(100 * time.Millisecond):
		// Release a blocked legacy reader so the red test leaves no goroutine.
		file, _ := os.OpenFile(path, os.O_WRONLY|syscall.O_NONBLOCK, 0)
		if file != nil {
			file.Close()
		}
		t.Fatal("certificate preparation blocks on a non-regular file")
	}
}

func TestPreparationAllowsOwnedWildcardNarrowingOnly(t *testing.T) {
	active, err := net.Listen("tcp4", "0.0.0.0:0")
	if err != nil {
		t.Fatal(err)
	}
	defer active.Close()
	_, port, _ := net.SplitHostPort(active.Addr().String())
	candidate := config.TLSCandidate{Listen: net.JoinHostPort("127.0.0.1", port), TLS: config.TLSConfig{Mode: "http"}}
	if _, err := PrepareCandidate(context.Background(), candidate, net.JoinHostPort("0.0.0.0", port), nil, nil); err != nil {
		t.Fatalf("owned wildcard narrowing rejected: %v", err)
	}
	if _, err := PrepareCandidate(context.Background(), candidate, "127.0.0.1:1", nil, nil); err == nil {
		t.Fatal("external wildcard conflict accepted")
	}
	candidate.Listen = net.JoinHostPort("0.0.0.0", port)
	if _, err := PrepareCandidate(context.Background(), candidate, net.JoinHostPort("127.0.0.1", port), nil, nil); err == nil {
		t.Fatal("unproven listener widening accepted")
	}
}
