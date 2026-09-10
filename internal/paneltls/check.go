package paneltls

import (
	"context"
	"crypto/tls"
	"crypto/x509"
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
	host, port, err := net.SplitHostPort(cfg.Listen)
	if err != nil {
		return fmt.Errorf("check listen address: %w", err)
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
			return fmt.Errorf("read configured certificate for health check: %w", err)
		}
		pair, err := tls.LoadX509KeyPair(cfg.TLS.CertFile, cfg.TLS.KeyFile)
		if err != nil {
			return fmt.Errorf("load configured certificate/key for health check: %w", err)
		}
		leaf, err := x509.ParseCertificate(pair.Certificate[0])
		if err != nil {
			return err
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
			return fmt.Errorf("configured certificate contains no trust material")
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
	endpoint := scheme + "://" + net.JoinHostPort(name, port) + "/api/health"
	var last error
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return err
		}
		res, err := client.Do(req)
		if err == nil {
			var body struct{ Status, Version string }
			decodeErr := json.NewDecoder(io.LimitReader(res.Body, 8192)).Decode(&body)
			_ = res.Body.Close()
			if res.StatusCode == http.StatusOK && decodeErr == nil && body.Status == "ok" && body.Version == expectedVersion {
				return nil
			}
			err = fmt.Errorf("unexpected health response: HTTP %d; expected panel version %q", res.StatusCode, expectedVersion)
		}
		last = err
		select {
		case <-ctx.Done():
			return fmt.Errorf("%s health check did not succeed: %v: %w", scheme, last, ctx.Err())
		case <-time.After(time.Second):
		}
	}
}
