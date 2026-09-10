package paneltls

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/amirotin/telemt_panel/internal/config"
	"golang.org/x/crypto/acme/autocert"
)

// PrepareTimeout leaves room for HTTP response delivery below two minutes.
const PrepareTimeout = 110 * time.Second

// CertificateInfo exposes verified public metadata, never key material.
type CertificateInfo struct {
	Domain          string    `json:"domain,omitempty"`
	ExpiresAt       time.Time `json:"expires_at"`
	PubliclyTrusted bool      `json:"publicly_trusted"`
	fingerprint     [32]byte
}

func readPEMFile(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 1<<20 {
		return nil, errors.New("certificate/key must be readable regular PEM files no larger than 1 MiB")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 1<<20+1))
	if err != nil || len(data) > 1<<20 {
		return nil, errors.New("cannot read bounded certificate/key file")
	}
	return data, nil
}

func loadCertificatePair(certPath, keyPath string) (tls.Certificate, error) {
	cert, err := readPEMFile(certPath)
	if err != nil {
		return tls.Certificate{}, err
	}
	key, err := readPEMFile(keyPath)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.X509KeyPair(cert, key)
}

// VerifyPreparedCache rechecks persisted key/chain and startup cache usability,
// without constructing a manager, contacting a CA or renewing a certificate.
func VerifyPreparedCache(c config.TLSCandidate, expected *CertificateInfo) error {
	invalid := &PrepareError{"tls_certificate_invalid", "prepared ACME certificate/key changed or is invalid; prepare again"}
	if c.Normalize("") != nil || c.TLS.Mode != "acme" || expected == nil {
		return invalid
	}
	info, err := os.Stat(c.TLS.AcmeCacheDir)
	if err != nil || !info.IsDir() {
		return &PrepareError{"tls_cache_unavailable", "prepared ACME cache directory is unavailable"}
	}
	if checkCache(c.TLS.AcmeCacheDir) != nil {
		return &PrepareError{"tls_cache_unavailable", "prepared ACME cache must remain writable by the panel service user"}
	}
	// Pinned x/crypto autocert v0.55.0 stores its combined PEM under the bare
	// domain for ECDSA. tls prepare explicitly requests ECDSA; never fall back
	// to another algorithm's entry or invoke GetCertificate on a cache miss.
	data, err := readPEMFile(filepath.Join(c.TLS.AcmeCacheDir, c.TLS.AcmeDomain))
	if err != nil {
		return &PrepareError{"tls_cache_unavailable", "prepared ACME certificate/key is no longer readable in its cache"}
	}
	pair, err := tls.X509KeyPair(data, data)
	if err != nil {
		return invalid
	}
	actual, err := verifyChain(pair.Certificate, c.TLS.AcmeDomain, true, nil)
	if err != nil {
		return err
	}
	if *actual != *expected {
		return invalid
	}
	return nil
}

// PrepareError carries a safe actionable API code without CA/token/key output.
type PrepareError struct{ Code, Message string }

func (e *PrepareError) Error() string { return e.Message }

// AcquisitionRunner obtains the public DER certificate chain in a bounded child.
type AcquisitionRunner func(context.Context, config.TLSCandidate) ([][]byte, error)

// ChallengeMux adds one temporary candidate without stealing active renewal tokens.
type ChallengeMux struct {
	mu        sync.RWMutex
	active    http.Handler
	candidate http.Handler
	domain    string
}

// NewChallengeMux wraps the already configured challenge handler, if any.
func NewChallengeMux(active http.Handler) *ChallengeMux { return &ChallengeMux{active: active} }

// Install limits candidate routing to GET HTTP-01 requests for exactly one host.
func (m *ChallengeMux) Install(domain string, handler http.Handler) (func(), error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.candidate != nil {
		return nil, &PrepareError{"tls_prepare_busy", "another certificate preparation is running"}
	}
	m.candidate, m.domain = handler, domain
	return func() { m.mu.Lock(); m.candidate = nil; m.domain = ""; m.mu.Unlock() }, nil
}

type challengeResponse struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (w *challengeResponse) Header() http.Header { return w.header }
func (w *challengeResponse) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
}
func (w *challengeResponse) Write(p []byte) (int, error) {
	w.WriteHeader(200)
	if w.body.Len()+len(p) > 16<<10 {
		return 0, errors.New("challenge response too large")
	}
	return w.body.Write(p)
}

func (m *ChallengeMux) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	if m.candidate != nil && r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/.well-known/acme-challenge/") && strings.EqualFold(strings.TrimSuffix(host, "."), m.domain) {
		response := &challengeResponse{header: make(http.Header)}
		m.candidate.ServeHTTP(response, r)
		if response.status == 200 {
			for name, values := range response.header {
				w.Header()[name] = values
			}
			w.WriteHeader(200)
			_, _ = w.Write(response.body.Bytes())
			return
		}
	}
	if m.active != nil {
		m.active.ServeHTTP(w, r)
	} else {
		http.NotFound(w, r)
	}
}

// PrepareCandidate checks files/listener permissions and acquires before saving.
// Only the child calls autocert.GetCertificate; parent managers have no renewal timers.
func PrepareCandidate(ctx context.Context, c config.TLSCandidate, activeListen string, mux *ChallengeMux, run AcquisitionRunner) (*CertificateInfo, error) {
	return prepareCandidate(ctx, c, activeListen, mux, run, ":80")
}

func prepareCandidate(ctx context.Context, c config.TLSCandidate, activeListen string, mux *ChallengeMux, run AcquisitionRunner, challengeAddr string) (*CertificateInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, PrepareTimeout)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !canReuseActiveListener(c.Listen, activeListen) {
		ln, err := net.Listen("tcp", c.Listen)
		if err != nil {
			return nil, &PrepareError{"tls_listener_unavailable", fmt.Sprintf("new listener %s: %v", c.Listen, err)}
		}
		defer ln.Close()
	}
	switch c.TLS.Mode {
	case "http":
		return nil, nil
	case "certificate":
		manager := New(c.TLS, c.Listen)
		defer manager.Close()
		tlsConfig, _, err := manager.Prepare()
		if err != nil {
			return nil, &PrepareError{"tls_certificate_invalid", "cannot read a matching certificate/key pair as the panel service user"}
		}
		domain := ""
		if c.PublicURL != "" {
			public, err := url.Parse(c.PublicURL)
			if err != nil {
				return nil, err
			}
			domain = public.Hostname()
		}
		return verifyChain(tlsConfig.Certificates[0].Certificate, domain, false, nil)
	case "acme":
		if err := checkCache(c.TLS.AcmeCacheDir); err != nil {
			return nil, &PrepareError{"tls_cache_unavailable", "ACME cache is not writable as the panel service user; choose persistent storage"}
		}
		if mux == nil {
			mux = NewChallengeMux(nil)
		}
		reader := &autocert.Manager{Cache: autocert.DirCache(c.TLS.AcmeCacheDir), HostPolicy: acmeHostPolicy(c.TLS.AcmeDomain)}
		remove, err := mux.Install(c.TLS.AcmeDomain, reader.HTTPHandler(http.NotFoundHandler()))
		if err != nil {
			return nil, err
		}
		defer remove()
		if mux.active == nil {
			ln, err := net.Listen("tcp", challengeAddr)
			if err != nil {
				return nil, &PrepareError{"tls_challenge_unavailable", fmt.Sprintf("ACME HTTP-01 listener %s: %v", challengeAddr, err)}
			}
			server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 10 * time.Second, MaxHeaderBytes: 16 << 10}
			done := make(chan struct{})
			go func() { defer close(done); _ = server.Serve(ln) }()
			defer func() { _ = server.Close(); _ = ln.Close(); <-done }()
		}
		if run == nil {
			run = RunAcquisition
		}
		chain, err := run(ctx, c)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, &PrepareError{"tls_acquisition_failed", "certificate acquisition failed; check domain DNS, public port 80, CA availability and persistent cache permissions"}
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return verifyChain(chain, c.TLS.AcmeDomain, true, nil)
	default:
		return nil, &PrepareError{"tls_invalid_candidate", "unsupported TLS mode"}
	}
}

func canReuseActiveListener(candidate, active string) bool {
	if candidate == active {
		return true
	}
	candidateHost, candidatePort, candidateErr := net.SplitHostPort(candidate)
	activeHost, activePort, activeErr := net.SplitHostPort(active)
	if candidateErr != nil || activeErr != nil || candidatePort != activePort {
		return false
	}
	candidateIP, activeIP := net.ParseIP(candidateHost), net.ParseIP(activeHost)
	// Only a literal same-family wildcard-to-loopback narrowing is proven by
	// the owned listener. DNS names, interface changes and widening still bind.
	return candidateIP != nil && activeIP != nil && candidateIP.IsLoopback() && activeIP.IsUnspecified() && (candidateIP.To4() != nil) == (activeIP.To4() != nil)
}

func verifyChain(chain [][]byte, domain string, requirePublic bool, roots *x509.CertPool) (*CertificateInfo, error) {
	invalid := &PrepareError{"tls_certificate_invalid", "certificate must be a currently valid server certificate for the configured domain"}
	if len(chain) == 0 {
		return nil, invalid
	}
	leaf, err := x509.ParseCertificate(chain[0])
	if err != nil || leaf.IsCA || time.Now().Before(leaf.NotBefore) || !time.Now().Before(leaf.NotAfter) {
		return nil, invalid
	}
	if domain != "" && leaf.VerifyHostname(domain) != nil {
		return nil, invalid
	}
	if len(leaf.ExtKeyUsage) > 0 {
		server := false
		for _, usage := range leaf.ExtKeyUsage {
			if usage == x509.ExtKeyUsageAny || usage == x509.ExtKeyUsageServerAuth {
				server = true
			}
		}
		if !server {
			return nil, invalid
		}
	}
	intermediates := x509.NewCertPool()
	for _, der := range chain[1:] {
		cert, err := x509.ParseCertificate(der)
		if err != nil {
			return nil, invalid
		}
		intermediates.AddCert(cert)
	}
	_, trustErr := leaf.Verify(x509.VerifyOptions{DNSName: domain, Roots: roots, Intermediates: intermediates, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}})
	if requirePublic && trustErr != nil {
		return nil, &PrepareError{"tls_certificate_untrusted", "ACME certificate is not trusted by the system public CA roots"}
	}
	if domain == "" {
		if len(leaf.DNSNames) > 0 {
			domain = leaf.DNSNames[0]
		} else if len(leaf.IPAddresses) > 0 {
			domain = leaf.IPAddresses[0].String()
		}
	}
	hash := sha256.New()
	for _, der := range chain {
		_, _ = hash.Write(der)
	}
	var fingerprint [32]byte
	copy(fingerprint[:], hash.Sum(nil))
	return &CertificateInfo{Domain: domain, ExpiresAt: leaf.NotAfter, PubliclyTrusted: trustErr == nil, fingerprint: fingerprint}, nil
}

type boundedOutput struct{ bytes.Buffer }

func (b *boundedOutput) Write(p []byte) (int, error) {
	if b.Len()+len(p) > 128<<10 {
		return 0, errors.New("certificate helper output limit exceeded")
	}
	return b.Buffer.Write(p)
}

// RunAcquisition invokes this exact executable and UID; no arbitrary command/CA input.
func RunAcquisition(ctx context.Context, c config.TLSCandidate) ([][]byte, error) {
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	input, err := json.Marshal(c)
	if err != nil {
		return nil, err
	}
	command := exec.CommandContext(ctx, executable, "tls", "prepare")
	command.Stdin = bytes.NewReader(input)
	var output boundedOutput
	command.Stdout = &output
	command.Stderr = io.Discard
	command.WaitDelay = time.Second
	if err := command.Run(); err != nil {
		return nil, errors.New("certificate helper failed")
	}
	var chain [][]byte
	if err := json.Unmarshal(output.Bytes(), &chain); err != nil {
		return nil, errors.New("invalid certificate helper output")
	}
	return chain, nil
}

// AcquireInProcess is exclusively for the short-lived tls prepare command.
// Process exit, not Manager.Close, releases autocert's unexported renewal timers.
func AcquireInProcess(ctx context.Context, c config.TLSCandidate) ([][]byte, error) {
	manager := New(c.TLS, c.Listen)
	return acquireWithManager(ctx, c, manager, nil)
}

func acquireWithManager(ctx context.Context, c config.TLSCandidate, manager *Manager, roots *x509.CertPool) ([][]byte, error) {
	defer manager.Close()
	stop := context.AfterFunc(ctx, manager.Close)
	defer stop()
	tlsConfig, _, err := manager.Prepare()
	if err != nil {
		return nil, err
	}
	if c.TLS.Mode != "acme" || tlsConfig == nil {
		return nil, errors.New("ACME candidate required")
	}
	cert, err := tlsConfig.GetCertificate(&tls.ClientHelloInfo{ServerName: c.TLS.AcmeDomain,
		SupportedVersions: []uint16{tls.VersionTLS13, tls.VersionTLS12},
		CipherSuites:      []uint16{tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256},
		SupportedCurves:   []tls.CurveID{tls.CurveP256}, SignatureSchemes: []tls.SignatureScheme{tls.ECDSAWithP256AndSHA256}})
	if err != nil {
		return nil, err
	}
	if _, err := verifyChain(cert.Certificate, c.TLS.AcmeDomain, true, roots); err != nil {
		return nil, err
	}
	// autocert can serve a newly issued in-memory certificate even when its
	// cache write fails. A receipt must guarantee restart can reuse it.
	if manager.Status().Stage == "cache" {
		return nil, &PrepareError{"tls_cache_unavailable", "issued certificate could not be persisted to the ACME cache"}
	}
	return cert.Certificate, nil
}
