package paneltls

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/config"
	"golang.org/x/crypto/acme/autocert"
)

// Local CA configuration exists exclusively in this test subprocess, never API/CLI flags.
func TestTLSAcquisitionChildHelper(t *testing.T) {
	if os.Getenv("PANEL_TEST_ACQUIRE_CHILD") != "1" {
		return
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	var input struct {
		Candidate config.TLSCandidate
		Directory string
		Root      []byte
	}
	if json.NewDecoder(os.Stdin).Decode(&input) != nil {
		os.Exit(2)
	}
	root, err := x509.ParseCertificate(input.Root)
	if err != nil {
		os.Exit(3)
	}
	roots := x509.NewCertPool()
	roots.AddCert(root)
	manager := New(input.Candidate.TLS, input.Candidate.Listen)
	manager.directory = input.Directory
	if os.Getenv("PANEL_TEST_FAIL_CACHE") == "1" {
		manager.transport = failCertificateCacheTransport{cache: input.Candidate.TLS.AcmeCacheDir}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	chain, err := acquireWithManager(ctx, input.Candidate, manager, roots)
	if err != nil {
		os.Exit(4)
	}
	if json.NewEncoder(os.Stdout).Encode(chain) != nil {
		os.Exit(5)
	}
	os.Exit(0)
}

type failCertificateCacheTransport struct{ cache string }

func (tr failCertificateCacheTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	response, err := http.DefaultTransport.RoundTrip(r)
	if err == nil && strings.HasSuffix(r.URL.Path, "/cert") {
		if err := os.Rename(tr.cache, tr.cache+".retained"); err != nil {
			response.Body.Close()
			return nil, err
		}
		if err := os.WriteFile(tr.cache, []byte("cache unavailable"), 0600); err != nil {
			response.Body.Close()
			return nil, err
		}
	}
	return response, err
}

func TestLocalCACandidateRejectsFailedPersistence(t *testing.T) {
	ca := newFakeCA(t, false, false)
	c := config.TLSCandidate{Listen: "127.0.0.1:8443", TLS: config.TLSConfig{Mode: "acme", AcmeDomain: "panel.example.com", AcmeCacheDir: t.TempDir() + "/cache"}}
	if err := os.Mkdir(c.TLS.AcmeCacheDir, 0700); err != nil {
		t.Fatal(err)
	}
	reader := &autocert.Manager{Cache: autocert.DirCache(c.TLS.AcmeCacheDir)}
	challenge := httptest.NewServer(reader.HTTPHandler(http.NotFoundHandler()))
	defer challenge.Close()
	ca.mu.Lock()
	ca.challengeURL = challenge.URL
	ca.mu.Unlock()
	executable, _ := os.Executable()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, executable, "-test.run=^TestTLSAcquisitionChildHelper$")
	command.Env = append(os.Environ(), "PANEL_TEST_ACQUIRE_CHILD=1", "PANEL_TEST_FAIL_CACHE=1")
	input, _ := json.Marshal(struct {
		Candidate config.TLSCandidate
		Directory string
		Root      []byte
	}{c, ca.server.URL + "/directory", ca.root.Raw})
	command.Stdin = bytes.NewReader(input)
	output, err := command.Output()
	if err == nil || len(output) != 0 {
		t.Fatalf("certificate returned despite failed cache persistence: exit=%v bytes=%d", err, len(output))
	}
	if ca.certificates.Load() != 1 {
		t.Fatal("test did not reach certificate issuance")
	}
}

func TestLocalCACandidateChildAcquisitionAndPublicTrust(t *testing.T) {
	ca := newFakeCA(t, false, false)
	ca.offerBrokenALPN = true
	c := config.TLSCandidate{Listen: "127.0.0.1:8443", TLS: config.TLSConfig{Mode: "acme", AcmeDomain: "panel.example.com", AcmeCacheDir: t.TempDir()}}
	reader := &autocert.Manager{Cache: autocert.DirCache(c.TLS.AcmeCacheDir)}
	challenge := httptest.NewServer(reader.HTTPHandler(http.NotFoundHandler()))
	defer challenge.Close()
	ca.mu.Lock()
	ca.challengeURL = challenge.URL
	ca.mu.Unlock()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, executable, "-test.run=^TestTLSAcquisitionChildHelper$")
	command.Env = append(os.Environ(), "PANEL_TEST_ACQUIRE_CHILD=1")
	input, _ := json.Marshal(struct {
		Candidate config.TLSCandidate
		Directory string
		Root      []byte
	}{c, ca.server.URL + "/directory", ca.root.Raw})
	command.Stdin = bytes.NewReader(input)
	output, err := command.Output()
	if err != nil {
		t.Fatalf("local CA child acquisition: %v", err)
	}
	var chain [][]byte
	if err := json.Unmarshal(output, &chain); err != nil {
		t.Fatal(err)
	}
	if ca.certificates.Load() != 1 || ca.challengeRequests.Load() == 0 {
		t.Fatal("child did not acquire through actual HTTP-01")
	}
	if ca.orders.Load() < 2 {
		t.Fatal("child did not exercise stock ALPN-to-HTTP01 fallback")
	}
	if _, err := verifyChain(chain, c.TLS.AcmeDomain, true, nil); err == nil {
		t.Fatal("private local CA falsely reported publicly trusted")
	}
	roots := x509.NewCertPool()
	roots.AddCert(ca.root)
	if cert, err := verifyChain(chain, c.TLS.AcmeDomain, true, roots); err != nil || !cert.PubliclyTrusted {
		t.Fatalf("issued certificate failed trusted-root verification: %v", err)
	}
}
