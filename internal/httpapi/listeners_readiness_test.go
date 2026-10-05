package httpapi

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

func TestListenersReadinessWithoutRequest(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var ready atomic.Bool
	err := serveListeners(ctx, &http.Server{Addr: "127.0.0.1:0"}, &http.Server{Addr: "127.0.0.1:0"}, func() error {
		ready.Store(true)
		cancel()
		return nil
	}, &http.Server{Addr: "127.0.0.1:0"})
	if err != nil || !ready.Load() {
		t.Fatalf("readiness=%v error=%v; all serve loops must signal without an HTTP request", ready.Load(), err)
	}
}

func TestListenersReadinessFailureClosesListeners(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	addr := reserveAddress(t)
	cause := errors.New("confirmation failed")
	err := serveListeners(ctx, &http.Server{Addr: addr}, nil, func() error { return cause })
	if !errors.Is(err, cause) {
		t.Fatalf("error=%v, want readiness confirmation error", err)
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatalf("callback failure leaked listener: %v", err)
	}
	_ = listener.Close()
}

func TestListenersImmediateTLSFailureDoesNotConfirmReadiness(t *testing.T) {
	var ready atomic.Bool
	err := serveListeners(context.Background(), &http.Server{Addr: "127.0.0.1:0", TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12}}, nil, func() error {
		ready.Store(true)
		return nil
	})
	if err == nil || ready.Load() {
		t.Fatalf("ready=%v error=%v", ready.Load(), err)
	}
}

func TestListenersEveryRequiredPortMustBindBeforeReadiness(t *testing.T) {
	for _, occupied := range []int{0, 1, 2} {
		t.Run([]string{"panel", "challenge", "subscription"}[occupied], func(t *testing.T) {
			busy, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer busy.Close()
			servers := []*http.Server{{Addr: reserveAddress(t)}, {Addr: reserveAddress(t)}, {Addr: reserveAddress(t)}}
			servers[occupied].Addr = busy.Addr().String()
			var ready atomic.Bool
			err = serveListeners(context.Background(), servers[0], servers[1], func() error { ready.Store(true); return nil }, servers[2])
			if err == nil || ready.Load() {
				t.Fatalf("ready=%v error=%v", ready.Load(), err)
			}
			for i, server := range servers {
				if i == occupied {
					continue
				}
				listener, err := net.Listen("tcp", server.Addr)
				if err != nil {
					t.Fatalf("listener leaked at %s: %v", server.Addr, err)
				}
				_ = listener.Close()
			}
		})
	}
}

func TestListenersShutdownTimeoutForcesConnectionClose(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	addr := reserveAddress(t)
	finished := make(chan struct{})
	server := &http.Server{Addr: addr, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cancel()
		<-r.Context().Done()
		close(finished)
	})}
	clientFinished := make(chan struct{})
	started := time.Now()
	err := serveListeners(ctx, server, nil, func() error {
		go func() {
			defer close(clientFinished)
			response, err := http.Get("http://" + addr)
			if err == nil {
				_ = response.Body.Close()
			}
		}()
		return nil
	})
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(started) > 12*time.Second {
		t.Fatalf("shutdown error=%v elapsed=%s", err, time.Since(started))
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("forced close did not cancel handler")
	}
	<-clientFinished
}
