package httpapi

import (
	"context"
	"crypto/tls"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type handshakeCounter struct{ count atomic.Int32 }

func (h *handshakeCounter) Enabled(context.Context, slog.Level) bool { return true }
func (h *handshakeCounter) WithAttrs([]slog.Attr) slog.Handler       { return h }
func (h *handshakeCounter) WithGroup(string) slog.Handler            { return h }
func (h *handshakeCounter) Handle(_ context.Context, r slog.Record) error {
	if strings.Contains(r.Message, "TLS handshake error") {
		h.count.Add(1)
	}
	return nil
}

func TestTLSHandshakeLogsAreBounded(t *testing.T) {
	counter := &handshakeCounter{}
	previous := slog.Default()
	slog.SetDefault(slog.New(counter))
	defer slog.SetDefault(previous)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	addr := reserveAddress(t)
	main := &http.Server{Addr: addr, TLSConfig: &tls.Config{
		MinVersion: tls.VersionTLS12,
		GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
			return nil, fmt.Errorf("test CA rejected issuance")
		},
	}}
	done := make(chan error, 1)
	go func() { done <- serveListeners(ctx, main, nil) }()
	client := &http.Client{Timeout: time.Second}
	deadline := time.Now().Add(3 * time.Second)
	for counter.count.Load() == 0 && time.Now().Before(deadline) {
		if res, err := client.Get("https://" + addr); err == nil {
			_ = res.Body.Close()
			t.Error("failed issuance unexpectedly served HTTPS")
		}
		time.Sleep(time.Millisecond)
	}
	for range 4 {
		if res, err := client.Get("https://" + addr); err == nil {
			_ = res.Body.Close()
			t.Error("failed issuance unexpectedly served HTTPS")
		}
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if got := counter.count.Load(); got != 1 {
		t.Fatalf("expected one diagnostic for repeated handshake failures, got %d", got)
	}
}

func reserveAddress(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	return addr
}

func TestChallengeBindFailureClosesMainListener(t *testing.T) {
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()
	addr := reserveAddress(t)
	err = serveListeners(context.Background(), &http.Server{Addr: addr}, &http.Server{Addr: busy.Addr().String()})
	if err == nil || !strings.Contains(err.Error(), "HTTP-01") {
		t.Fatalf("error=%v", err)
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatalf("main listener leaked: %v", err)
	}
	_ = ln.Close()
}

func TestListenersShutdownTogether(t *testing.T) {
	mainAddr, challengeAddr := reserveAddress(t), reserveAddress(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	main := &http.Server{Addr: mainAddr, Handler: http.NotFoundHandler()}
	challenge := &http.Server{Addr: challengeAddr, Handler: http.NotFoundHandler()}
	done := make(chan error, 1)
	go func() { done <- serveListeners(ctx, main, challenge) }()
	deadline := time.Now().Add(3 * time.Second)
	for _, addr := range []string{mainAddr, challengeAddr} {
		for {
			conn, err := net.DialTimeout("tcp", addr, 30*time.Millisecond)
			if err == nil {
				_ = conn.Close()
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("listener did not start")
			}
			time.Sleep(time.Millisecond)
		}
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("shutdown blocked")
	}
	for _, addr := range []string{mainAddr, challengeAddr} {
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			t.Fatalf("listener leaked: %v", err)
		}
		_ = ln.Close()
	}
}
