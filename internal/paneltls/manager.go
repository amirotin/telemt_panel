// Package paneltls manages the panel's own HTTPS certificates independently of history storage.
package paneltls

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/amirotin/telemt_panel/internal/config"
	"golang.org/x/crypto/acme"
	"golang.org/x/crypto/acme/autocert"
)

// Status contains only public certificate metadata and bounded diagnostics.
type Status struct {
	Mode      string     `json:"mode"`
	State     string     `json:"state"`
	Domain    string     `json:"domain,omitempty"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
	Stage     string     `json:"stage,omitempty"`
	Error     string     `json:"error,omitempty"`
}

// Manager owns one configured domain, its certificate cache and diagnostics.
type Manager struct {
	cfg               config.TLSConfig
	listen            string
	directory         string
	transport         http.RoundTripper
	ctx               context.Context
	cancel            context.CancelFunc
	mu                sync.Mutex
	status            Status
	lastLog           time.Time
	notBefore         time.Time
	failureGeneration uint64
	issuedGeneration  uint64
	issuedFingerprint [32]byte
}

// New does no I/O; Prepare runs the filesystem checks before listeners start.
func New(cfg config.TLSConfig, listen string) *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	mode := cfg.Mode
	if mode == "" {
		mode = "http"
	}
	return &Manager{cfg: cfg, listen: listen, directory: autocert.DefaultACMEDirectory,
		transport: http.DefaultTransport, ctx: ctx, cancel: cancel,
		status: Status{Mode: mode, Domain: cfg.AcmeDomain}}
}

// Close cancels outstanding CA requests, including background renewal requests.
func (m *Manager) Close() { m.cancel() }

// Status returns a snapshot; an expiring certificate is not reported as healthy.
func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.status
	s.State = "waiting"
	if s.Mode == "http" {
		s.State = "http"
		return s
	}
	if s.ExpiresAt != nil {
		exp := *s.ExpiresAt
		s.ExpiresAt = &exp
		s.State = "ready"
		if time.Until(exp) < 7*24*time.Hour || s.Error != "" {
			s.State = "warning"
		}
		if !exp.After(time.Now()) {
			s.State = "error"
		}
		if time.Now().Before(m.notBefore) {
			s.State = "error"
		}
	} else if s.Error != "" {
		s.State = "error"
	}
	return s
}

// Prepare returns TLS settings and an optional HTTP-01 handler. Neither serves the application over HTTP in a TLS mode.
func (m *Manager) Prepare() (*tls.Config, http.Handler, error) {
	switch m.status.Mode {
	case "http":
		return nil, nil, nil
	case "certificate":
		cert, err := loadCertificatePair(m.cfg.CertFile, m.cfg.KeyFile)
		if err != nil {
			return nil, nil, m.failure("certificate", fmt.Errorf("read certificate/key pair: %w", err))
		}
		leaf, err := x509.ParseCertificate(cert.Certificate[0])
		if err != nil {
			return nil, nil, m.failure("certificate", err)
		}
		m.certificate(leaf)
		return &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{cert}}, nil, nil
	case "acme":
		if err := checkCache(m.cfg.AcmeCacheDir); err != nil {
			return nil, nil, m.failure("cache", err)
		}
		manager := &autocert.Manager{
			Prompt:     autocert.AcceptTOS,
			HostPolicy: autocert.HostWhitelist(m.cfg.AcmeDomain),
			Cache:      &observedCache{DirCache: autocert.DirCache(m.cfg.AcmeCacheDir), owner: m},
			Client: &acme.Client{DirectoryURL: m.directory, HTTPClient: &http.Client{
				Timeout: 30 * time.Second, Transport: &observedTransport{owner: m, next: m.transport},
			}},
		}
		handler := manager.HTTPHandler(m.redirect())
		tlsConfig := manager.TLSConfig()
		tlsConfig.MinVersion = tls.VersionTLS12
		tlsConfig.GetCertificate = func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
			// HostPolicy alone does not protect already-cached certificates.
			if !strings.EqualFold(strings.TrimSuffix(hello.ServerName, "."), m.cfg.AcmeDomain) {
				return nil, fmt.Errorf("TLS server name is not the configured panel domain")
			}
			m.mu.Lock()
			generation := m.failureGeneration
			m.mu.Unlock()
			cert, err := manager.GetCertificate(hello)
			if err != nil {
				if m.ctx.Err() != nil {
					return nil, err
				}
				return nil, m.failure("issuance", err)
			}
			if len(cert.Certificate) != 0 {
				if leaf, err := x509.ParseCertificate(cert.Certificate[0]); err == nil {
					m.certificate(leaf)
				}
			}
			// A successful retry may clear its older issuance error, but a cached
			// handshake must never erase an ongoing renewal/cache failure.
			m.mu.Lock()
			if m.failureGeneration == generation && m.status.Stage == "issuance" {
				m.status.Stage, m.status.Error = "", ""
			}
			m.mu.Unlock()
			return cert, nil
		}
		return tlsConfig, handler, nil
	default:
		return nil, nil, fmt.Errorf("unsupported TLS mode")
	}
}

func checkCache(dir string) error {
	if dir == "" {
		return fmt.Errorf("ACME cache directory is required")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("create ACME cache %q: %w", dir, err)
	}
	f, err := os.CreateTemp(dir, ".write-check-*")
	if err != nil {
		return fmt.Errorf("write ACME cache %q as the service user: %w", dir, err)
	}
	closeErr := f.Close()
	removeErr := os.Remove(f.Name())
	if closeErr != nil {
		return fmt.Errorf("close ACME cache write check: %w", closeErr)
	}
	if removeErr != nil {
		return fmt.Errorf("remove ACME cache write check: %w", removeErr)
	}
	return nil
}

func (m *Manager) redirect() http.Handler {
	_, port, _ := net.SplitHostPort(m.listen)
	host := m.cfg.AcmeDomain
	if port != "443" {
		host = net.JoinHostPort(host, port)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "HTTPS required", http.StatusBadRequest)
			return
		}
		requestHost := r.Host
		if h, _, err := net.SplitHostPort(requestHost); err == nil {
			requestHost = h
		}
		if !strings.EqualFold(strings.TrimSuffix(requestHost, "."), m.cfg.AcmeDomain) {
			http.NotFound(w, r)
			return
		}
		target := url.URL{Scheme: "https", Host: host, Path: r.URL.Path, RawPath: r.URL.RawPath, RawQuery: r.URL.RawQuery}
		http.Redirect(w, r, target.String(), http.StatusFound)
	})
}

var challengeToken = regexp.MustCompile(`(/\.well-known/acme-challenge/)[^\s"'<>]+`)

func (m *Manager) failure(stage string, err error) error {
	message := challengeToken.ReplaceAllString(err.Error(), `${1}[redacted]`)
	if len(message) > 800 {
		message = message[:800]
	}
	m.mu.Lock()
	m.failureGeneration++
	m.status.Stage, m.status.Error = stage, message
	shouldLog := time.Since(m.lastLog) >= time.Minute
	if shouldLog {
		m.lastLog = time.Now()
	}
	m.mu.Unlock()
	if shouldLog {
		slog.Warn("panel HTTPS: check domain DNS, public port 80, service permissions and CA availability", "stage", stage, "error", message)
	}
	return fmt.Errorf("panel HTTPS %s: %s", stage, message)
}

func (m *Manager) certificate(cert *x509.Certificate) {
	// HTTP/TLS challenges may use a short-lived validation certificate, not the application's certificate.
	for _, ext := range cert.Extensions {
		if ext.Id.String() == "1.3.6.1.5.5.7.1.31" {
			return
		}
	}
	if cert.IsCA {
		return
	}
	if m.cfg.AcmeDomain != "" && cert.VerifyHostname(m.cfg.AcmeDomain) != nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	// A handshake using the previous certificate may return after renewal.
	if m.status.ExpiresAt != nil && cert.NotAfter.Before(*m.status.ExpiresAt) {
		return
	}
	m.notBefore = cert.NotBefore
	if m.status.Mode == "certificate" {
		if len(cert.DNSNames) > 0 {
			m.status.Domain = cert.DNSNames[0]
		} else if len(cert.IPAddresses) > 0 {
			m.status.Domain = cert.IPAddresses[0].String()
		}
	}
	if m.status.ExpiresAt == nil || !m.status.ExpiresAt.Equal(cert.NotAfter) {
		exp := cert.NotAfter
		m.status.ExpiresAt = &exp
		slog.Info("panel HTTPS certificate loaded", "domain", m.cfg.AcmeDomain, "expires_at", exp)
	}
	issued := sha256.Sum256(cert.Raw) == m.issuedFingerprint && m.failureGeneration == m.issuedGeneration
	if (m.status.Mode != "acme" || issued) && m.status.Stage != "cache" {
		m.status.Stage, m.status.Error = "", ""
	}
}

type observedCache struct {
	autocert.DirCache
	owner *Manager
}

func (c *observedCache) Put(ctx context.Context, key string, data []byte) error {
	if err := c.owner.ctx.Err(); err != nil {
		return err
	}
	if err := c.DirCache.Put(ctx, key, data); err != nil {
		return c.owner.failure("cache", err)
	}
	c.owner.mu.Lock()
	if c.owner.status.Stage == "cache" {
		c.owner.status.Stage, c.owner.status.Error = "", ""
	}
	c.owner.mu.Unlock()
	for len(data) > 0 {
		block, rest := pem.Decode(data)
		if block == nil {
			break
		}
		data = rest
		if block.Type == "CERTIFICATE" {
			if cert, err := x509.ParseCertificate(block.Bytes); err == nil {
				c.owner.certificate(cert)
			}
		}
	}
	return nil
}

type observedTransport struct {
	owner *Manager
	next  http.RoundTripper
}

type cancelBody struct {
	captureCertificate bool
	io.ReadCloser
	done    func()
	owner   *Manager
	capture bool
	body    []byte
	status  int
	retry   string
}

func (b *cancelBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if b.capture || b.captureCertificate {
		if len(b.body)+n <= 16*1024 {
			b.body = append(b.body, p[:n]...)
		} else {
			b.capture, b.body = false, nil
			b.captureCertificate = false
		}
	}
	if err == io.EOF && b.captureCertificate && b.owner.ctx.Err() == nil {
		b.owner.observeIssuedCertificate(b.body)
		b.captureCertificate = false
	}
	return n, err
}

func (b *cancelBody) Close() error {
	defer b.done()
	if b.capture && b.owner.ctx.Err() == nil {
		b.owner.observeProblem(b.body, b.status, b.retry)
	}
	return b.ReadCloser.Close()
}

// observeIssuedCertificate marks complete bounded CA responses before autocert
// starts renewal; only that same leaf can clear errors older than its issuance.
func (m *Manager) observeIssuedCertificate(body []byte) {
	var leaf *x509.Certificate
	for len(bytes.TrimSpace(body)) > 0 {
		body = bytes.TrimSpace(body)
		if !bytes.HasPrefix(body, []byte("-----BEGIN CERTIFICATE-----")) {
			return
		}
		block, rest := pem.Decode(body)
		if block == nil || block.Type != "CERTIFICATE" {
			return
		}
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return
		}
		if leaf == nil {
			leaf = cert
		}
		body = rest
	}
	if leaf == nil || leaf.IsCA || leaf.VerifyHostname(m.cfg.AcmeDomain) != nil {
		return
	}
	m.mu.Lock()
	m.issuedGeneration = m.failureGeneration
	m.issuedFingerprint = sha256.Sum256(leaf.Raw)
	m.mu.Unlock()
}

// observeProblem observes a bounded copy without changing the ACME client's response.
// Renewal errors are otherwise internal to autocert while it serves the old certificate.
func (m *Manager) observeProblem(body []byte, status int, retry string) {
	type problem struct{ Type, Detail string }
	var response struct {
		Type, Detail string
		Status       json.RawMessage
		Error        *problem
		Challenges   []struct{ Error *problem }
	}
	if json.Unmarshal(body, &response) != nil {
		return
	}
	p := response.Error
	if strings.HasPrefix(response.Type, "urn:ietf:params:acme:error:") {
		p = &problem{response.Type, response.Detail}
	}
	// Problem documents use an HTTP number; authorization/order documents use a state string.
	var state string
	_ = json.Unmarshal(response.Status, &state)
	if state == "invalid" && p == nil {
		for _, challenge := range response.Challenges {
			if challenge.Error != nil {
				p = challenge.Error
				break
			}
		}
		if p == nil {
			p = &problem{Detail: "CA returned an invalid authorization or order"}
		}
	}
	// A stale nonce is transparently retried by the ACME client, not an operator failure.
	if p != nil && p.Type != "urn:ietf:params:acme:error:badNonce" {
		m.failure("ca_response", fmt.Errorf("CA HTTP %d (%s): %s; Retry-After: %.100s", status, p.Type, p.Detail, retry))
	}
}

func (t *observedTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if err := t.owner.ctx.Err(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(r.Context())
	stop := context.AfterFunc(t.owner.ctx, cancel)
	// The response body may outlive RoundTrip. The request's own timeout bounds it;
	// cancellation of the owner still interrupts a blocked RoundTrip during shutdown.
	res, err := t.next.RoundTrip(r.Clone(ctx))
	if err != nil {
		stop()
		cancel()
		if t.owner.ctx.Err() == nil {
			t.owner.failure("ca_connection", err)
		}
		return nil, err
	}
	contentType := res.Header.Get("Content-Type")
	res.Body = &cancelBody{ReadCloser: res.Body, owner: t.owner,
		status: res.StatusCode, retry: res.Header.Get("Retry-After"),
		captureCertificate: res.StatusCode >= 200 && res.StatusCode < 300 && strings.HasPrefix(contentType, "application/pem-certificate-chain"),
		capture:            strings.Contains(contentType, "application/json") || strings.Contains(contentType, "application/problem+json"),
		done:               func() { stop(); cancel() }}
	if res.StatusCode == http.StatusTooManyRequests || res.StatusCode >= 500 {
		t.owner.failure("ca_response", fmt.Errorf("CA returned HTTP %d; Retry-After: %.100s", res.StatusCode, res.Header.Get("Retry-After")))
	}
	return res, nil
}
