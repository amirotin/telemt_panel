package geoip

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"time"
)

const (
	downloadDeadline = 120 * time.Second
	maxRedirects     = 5
)

type downloader interface {
	download(context.Context, string, string) error
}

type ipResolver interface {
	LookupNetIP(context.Context, string, string) ([]netip.Addr, error)
}

type secureDownloader struct {
	client   *http.Client
	maxBytes int64
}

func newSecureDownloader() downloader {
	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	transport := newPinnedTransport(net.DefaultResolver, dialer.DialContext)
	return &secureDownloader{maxBytes: maxDatabaseBytes, client: &http.Client{
		Transport: transport,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) > maxRedirects {
				return errors.New("geoip: redirect limit exceeded")
			}
			return validateRemoteURL(request.URL.String())
		},
	}}
}

func newPinnedTransport(resolver ipResolver, dial func(context.Context, string, string) (net.Conn, error)) *http.Transport {
	return &http.Transport{
		Proxy:                 nil,
		ForceAttemptHTTP2:     true,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		IdleConnTimeout:       30 * time.Second,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(address)
			if err != nil {
				return nil, errors.New("geoip: invalid remote address")
			}
			addresses, err := resolver.LookupNetIP(ctx, "ip", host)
			if err != nil || len(addresses) == 0 {
				return nil, errors.New("geoip: DNS resolution failed")
			}
			for _, addr := range addresses {
				if !isAllowedDownloadIP(addr.Unmap()) {
					return nil, errors.New("geoip: DNS resolved to a non-public address")
				}
			}
			var dialErr error
			for _, addr := range addresses {
				conn, err := dial(ctx, network, net.JoinHostPort(addr.String(), port))
				if err == nil {
					return conn, nil
				}
				dialErr = err
			}
			return nil, dialErr
		},
	}
}

var blockedDownloadPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("100::/64"),
	netip.MustParsePrefix("64:ff9b::/96"),
	netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("2001::/32"),
	netip.MustParsePrefix("2001:2::/48"),
	netip.MustParsePrefix("2001:10::/28"),
	netip.MustParsePrefix("2001:20::/28"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("2002::/16"),
}

func isAllowedDownloadIP(addr netip.Addr) bool {
	if !addr.IsValid() || !addr.IsGlobalUnicast() || isNonPublic(addr) {
		return false
	}
	for _, prefix := range blockedDownloadPrefixes {
		if prefix.Contains(addr) {
			return false
		}
	}
	return true
}

func validateRemoteURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" || u.Opaque != "" {
		return errors.New("geoip: invalid remote URL")
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return errors.New("geoip: invalid remote URL")
		}
	}
	return nil
}

func (d *secureDownloader) download(ctx context.Context, rawURL, destination string) (err error) {
	if err := validateRemoteURL(rawURL); err != nil {
		return coded(ErrorDownloadFailed, err)
	}
	ctx, cancel := context.WithTimeout(ctx, downloadDeadline)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return coded(ErrorDownloadFailed, err)
	}
	response, err := d.client.Do(request)
	if err != nil {
		return coded(ErrorDownloadFailed, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return coded(ErrorDownloadFailed, nil)
	}
	limit := d.maxBytes
	if limit <= 0 {
		limit = maxDatabaseBytes
	}
	if response.ContentLength > limit {
		return coded(ErrorDownloadTooLarge, nil)
	}
	out, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o400)
	if err != nil {
		return coded(ErrorActivationFailed, err)
	}
	complete := false
	defer func() {
		if !complete {
			_ = os.Remove(destination)
		}
	}()
	written, copyErr := io.Copy(out, io.LimitReader(response.Body, limit+1))
	closeErr := out.Close()
	if copyErr != nil {
		return coded(ErrorDownloadFailed, copyErr)
	}
	if closeErr != nil {
		return coded(ErrorActivationFailed, closeErr)
	}
	if written > limit {
		return coded(ErrorDownloadTooLarge, nil)
	}
	complete = true
	return nil
}
