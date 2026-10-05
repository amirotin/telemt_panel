package update

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestLibcProbeDeadlineStopsBlockingCommand(t *testing.T) {
	exited := make(chan struct{})
	p := defaultProbe(context.Background(), func(ctx context.Context, name string, args ...string) ([]byte, []byte, error) {
		if name != "ldd" || len(args) != 1 || args[0] != "--version" {
			t.Errorf("unexpected command %s %v", name, args)
		}
		<-ctx.Done()
		close(exited)
		return nil, nil, ctx.Err()
	})
	start := time.Now()
	if _, err := p.LddVersion(); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("ldd error=%v", err)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("ldd exceeded bounded startup detection")
	}
	select {
	case <-exited:
	default:
		t.Fatal("command remained active after timeout")
	}
}

func TestLibcProbePreservesShorterCallerCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	p := defaultProbe(ctx, func(ctx context.Context, _ string, _ ...string) ([]byte, []byte, error) { return nil, nil, ctx.Err() })
	if _, err := p.LddVersion(); !errors.Is(err, context.Canceled) {
		t.Fatalf("ldd error=%v", err)
	}
	if got := DetectLibc(p); got != "musl" {
		t.Fatalf("canceled detection=%s", got)
	}
}
