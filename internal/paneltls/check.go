package paneltls

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/amirotin/telemt_panel/internal/config"
)

// Check waits for this local panel's health endpoint over its configured transport.
// ACME uses public CA validation and SNI, never InsecureSkipVerify. File mode trusts
// the explicitly configured certificate, which does not imply public browser trust.
func Check(ctx context.Context, cfg *config.Config, expectedVersion string) error {
	if expectedVersion == "" {
		return fmt.Errorf("expected panel version is required")
	}
	_, err := checkHealth(ctx, cfg, expectedVersion, "")
	return err
}

// Fingerprint captures a healthy local endpoint for rollback, including a 0.6
// SPA at /api/health. It discloses only the digest, never response contents.
func Fingerprint(ctx context.Context, cfg *config.Config) (string, error) {
	return checkHealth(ctx, cfg, "", "")
}

// CheckFingerprint verifies the exact pre-update public response after rollback.
func CheckFingerprint(ctx context.Context, cfg *config.Config, expected string) error {
	if decoded, err := hex.DecodeString(expected); err != nil || len(decoded) != sha256.Size {
		return fmt.Errorf("invalid health fingerprint")
	}
	_, err := checkHealth(ctx, cfg, "", expected)
	return err
}

func checkHealth(ctx context.Context, cfg *config.Config, expectedVersion, expectedFingerprint string) (string, error) {
	host, port, err := net.SplitHostPort(cfg.Listen)
	if err != nil {
		return "", fmt.Errorf("check listen address: %w", err)
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	addr := net.JoinHostPort(host, port)
	scheme := "http"
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	name := host
	if cfg.TLS.Mode == "acme" {
		scheme, name = "https", cfg.TLS.AcmeDomain
	}
	if cfg.TLS.Mode == "certificate" {
		scheme = "https"
		data, err := os.ReadFile(cfg.TLS.CertFile)
		if err != nil {
			return "", fmt.Errorf("read configured certificate for health check: %w", err)
		}
		pair, err := tls.LoadX509KeyPair(cfg.TLS.CertFile, cfg.TLS.KeyFile)
		if err != nil {
			return "", fmt.Errorf("load configured certificate/key for health check: %w", err)
		}
		leaf, err := x509.ParseCertificate(pair.Certificate[0])
		if err != nil {
			return "", err
		}
		if len(leaf.DNSNames) > 0 {
			name = leaf.DNSNames[0]
			if strings.HasPrefix(name, "*.") {
				name = "panel." + strings.TrimPrefix(name, "*.")
			}
		} else if len(leaf.IPAddresses) > 0 {
			name = leaf.IPAddresses[0].String()
		}
		tlsConfig.RootCAs = x509.NewCertPool()
		if !tlsConfig.RootCAs.AppendCertsFromPEM(data) {
			return "", fmt.Errorf("configured certificate contains no trust material")
		}
	}
	tlsConfig.ServerName = name
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	transport := &http.Transport{TLSClientConfig: tlsConfig,
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, network, addr)
		}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 15 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	endpoint := scheme + "://" + net.JoinHostPort(name, port) + cfg.BasePath + "/api/health"
	var last error
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return "", err
		}
		res, err := client.Do(req)
		if err == nil {
			data, readErr := io.ReadAll(io.LimitReader(res.Body, (64<<10)+1))
			_ = res.Body.Close()
			var body struct{ Status, Version string }
			decodeErr := json.Unmarshal(data, &body)
			digest := sha256.Sum256(data)
			fingerprint := hex.EncodeToString(digest[:])
			if res.StatusCode == http.StatusOK && readErr == nil && len(data) <= 64<<10 {
				if expectedVersion != "" && decodeErr == nil && body.Status == "ok" && body.Version == expectedVersion {
					return fingerprint, nil
				}
				if expectedVersion == "" && (expectedFingerprint == "" || fingerprint == expectedFingerprint) {
					return fingerprint, nil
				}
			}
			err = fmt.Errorf("unexpected health response: HTTP %d; expected panel version %q", res.StatusCode, expectedVersion)
			if expectedVersion == "" {
				err = fmt.Errorf("unexpected health response: HTTP %d; pre-update response not confirmed", res.StatusCode)
			}
		}
		last = err
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("%s health check did not succeed: %v: %w", scheme, last, ctx.Err())
		case <-time.After(time.Second):
		}
	}
}
