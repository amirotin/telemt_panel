package geoip

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strings"
	"testing"
	"time"
)

type resolverFunc func(context.Context, string, string) ([]netip.Addr, error)

func (f resolverFunc) LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error) {
	return f(ctx, network, host)
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func TestSecureDialRejectsNonPublicAndPinsResolvedAddress(t *testing.T) {
	for _, raw := range []string{
		"127.0.0.1", "10.0.0.1", "169.254.169.254", "224.0.0.1", "0.0.0.0",
		"100.64.0.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "240.0.0.1",
		"::1", "fe80::1", "ff02::1", "::", "2001:db8::1",
		"64:ff9b::a00:1", "64:ff9b:1::a00:1", "2002:a00:1::", "2001::1",
	} {
		t.Run(raw, func(t *testing.T) {
			called := false
			transport := newPinnedTransport(
				resolverFunc(func(context.Context, string, string) ([]netip.Addr, error) {
					return []netip.Addr{netip.MustParseAddr(raw)}, nil
				}),
				func(context.Context, string, string) (net.Conn, error) {
					called = true
					return nil, errors.New("unexpected")
				},
			)
			if _, err := transport.DialContext(context.Background(), "tcp", "example.test:443"); err == nil {
				t.Fatal("non-public address accepted")
			}
			if called {
				t.Fatal("dial attempted for non-public address")
			}
		})
	}

	transport := newPinnedTransport(
		resolverFunc(func(context.Context, string, string) ([]netip.Addr, error) {
			return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
		}),
		func(_ context.Context, _, address string) (net.Conn, error) {
			if address != "93.184.216.34:443" {
				t.Fatalf("dial address = %q", address)
			}
			return nil, errors.New("stop after pin assertion")
		},
	)
	if _, err := transport.DialContext(context.Background(), "tcp", "example.test:443"); err == nil {
		t.Fatal("fake dial error ignored")
	}
}

func TestSecureDialRejectsMixedDNSAnswers(t *testing.T) {
	transport := newPinnedTransport(
		resolverFunc(func(context.Context, string, string) ([]netip.Addr, error) {
			return []netip.Addr{netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr("127.0.0.1")}, nil
		}),
		func(context.Context, string, string) (net.Conn, error) {
			t.Fatal("dial called")
			return nil, nil
		},
	)
	if _, err := transport.DialContext(context.Background(), "tcp", "example.test:443"); err == nil {
		t.Fatal("mixed public/private answers accepted")
	}
}

func TestSecureDialFallsBackAcrossValidatedPinnedAddresses(t *testing.T) {
	var attempts []string
	resolverCalls := 0
	transport := newPinnedTransport(
		resolverFunc(func(context.Context, string, string) ([]netip.Addr, error) {
			resolverCalls++
			return []netip.Addr{
				netip.MustParseAddr("2001:4860:4860::8888"),
				netip.MustParseAddr("93.184.216.34"),
			}, nil
		}),
		func(_ context.Context, _, address string) (net.Conn, error) {
			attempts = append(attempts, address)
			if len(attempts) == 1 {
				return nil, errors.New("IPv6 unavailable")
			}
			client, server := net.Pipe()
			server.Close()
			return client, nil
		},
	)
	conn, err := transport.DialContext(context.Background(), "tcp", "example.test:443")
	if err != nil {
		t.Fatalf("fallback dial failed: %v", err)
	}
	conn.Close()
	want := []string{"[2001:4860:4860::8888]:443", "93.184.216.34:443"}
	if resolverCalls != 1 || len(attempts) != len(want) || attempts[0] != want[0] || attempts[1] != want[1] {
		t.Fatalf("resolver calls=%d attempts=%v, want %v", resolverCalls, attempts, want)
	}
}

func TestDownloaderValidatesURLAndRedirects(t *testing.T) {
	d := newSecureDownloader().(*secureDownloader)
	for _, raw := range []string{
		"http://example.test/db.mmdb",
		"https://user@example.test/db.mmdb",
		"https://example.test/db.mmdb#secret",
		"https:///db.mmdb",
	} {
		if err := validateRemoteURL(raw); err == nil {
			t.Errorf("accepted %q", raw)
		}
	}
	for i, raw := range []string{"https://user@example.test/db", "http://example.test/db"} {
		request, _ := http.NewRequest(http.MethodGet, raw, nil)
		if err := d.client.CheckRedirect(request, make([]*http.Request, i)); err == nil {
			t.Errorf("accepted unsafe redirect %q", raw)
		}
	}
	request, _ := http.NewRequest(http.MethodGet, "https://example.test/db", nil)
	if err := d.client.CheckRedirect(request, make([]*http.Request, maxRedirects+1)); err == nil {
		t.Fatal("accepted too many redirects")
	}
}

func TestDownloaderBoundsResponseAndUsesPerFileDeadline(t *testing.T) {
	tests := []struct {
		name          string
		contentLength int64
		body          string
		wantCode      string
	}{
		{name: "declared", contentLength: maxDatabaseBytes + 1, wantCode: ErrorDownloadTooLarge},
		{name: "streamed", contentLength: -1, body: strings.Repeat("x", int(maxDatabaseBytesForTest+1)), wantCode: ErrorDownloadTooLarge},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			d := &secureDownloader{maxBytes: maxDatabaseBytesForTest, client: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				if deadline, ok := request.Context().Deadline(); !ok || deadline.Sub(nowForDeadlineTest()) > downloadDeadline {
					t.Fatal("per-file deadline missing")
				}
				return &http.Response{
					StatusCode: http.StatusOK, ContentLength: test.contentLength,
					Body: io.NopCloser(strings.NewReader(test.body)), Header: make(http.Header),
				}, nil
			})}}
			err := d.download(context.Background(), "https://example.test/db.mmdb", t.TempDir()+"/db.mmdb")
			if errorCode(err) != test.wantCode {
				t.Fatalf("error = %v code=%q", err, errorCode(err))
			}
		})
	}
}

const maxDatabaseBytesForTest = int64(32)

func nowForDeadlineTest() time.Time { return time.Now() }

func TestDownloaderRemovesPartialFileOnFailure(t *testing.T) {
	d := &secureDownloader{maxBytes: 4, client: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, ContentLength: -1, Body: io.NopCloser(strings.NewReader("too long"))}, nil
	})}}
	path := t.TempDir() + "/db.mmdb"
	if err := d.download(context.Background(), "https://example.test/db.mmdb", path); err == nil {
		t.Fatal("oversized response accepted")
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("partial file retained: %v", err)
	}
}
