package telemt

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

func TestPatchConfigSlowPreparation(t *testing.T) {
	var patches atomic.Int32
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPatch {
			patches.Add(1)
			if r.Header.Get("If-Match") != "cfg-old" {
				t.Error("revision was lost")
			}
		}
		select {
		case <-time.After(100 * time.Millisecond):
		case <-r.Context().Done():
			return
		}
		w.Write([]byte(`{"ok":true,"data":{"revision":"cfg-new","changed":["web"]},"revision":"cfg-new"}`))
	})
	c.http.Timeout = 20 * time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result, _, revision, err := c.PatchConfig(ctx, map[string]any{"web": map[string]any{"enabled": false}}, "cfg-old", ReloadQuery{})
	if err != nil || revision != "cfg-new" || result.Revision != "cfg-new" {
		t.Fatalf("slow prepared PATCH: result=%+v revision=%q err=%v", result, revision, err)
	}
	if c.http.Timeout != 20*time.Millisecond {
		t.Fatal("ordinary client timeout was changed")
	}
	if _, _, err := c.GetConfig(context.Background()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("ordinary GET must keep its shorter timeout, got %v", err)
	}
	short, stop := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer stop()
	if _, _, _, err := c.PatchConfig(short, nil, "cfg-old", ReloadQuery{}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("PATCH must honor caller cancellation, got %v", err)
	}
	if patches.Load() != 2 {
		t.Fatalf("PATCH must never be retried automatically: calls=%d", patches.Load())
	}
}
