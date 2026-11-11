package telemt

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
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

func TestAccessPolicyPreparationRequestDeadline(t *testing.T) {
	c := New("http://telemt.test", "")
	var deadlines []time.Duration
	c.http.Transport = testRoundTripper(func(r *http.Request) (*http.Response, error) {
		deadline, ok := r.Context().Deadline()
		if !ok {
			t.Fatal("request has no preparation deadline")
		}
		deadlines = append(deadlines, time.Until(deadline))
		w := httptest.NewRecorder()
		w.Write([]byte(`{"ok":true,"revision":"s2","data":{"desired":{"user_max_tcp_conns_global_each":0,"user_max_unique_ips_global_each":0,"user_max_unique_ips_mode":"active_window","user_max_unique_ips_window_secs":30,"cidr_rate_limits":{}},"effective":{"user_max_tcp_conns_global_each":0,"user_max_unique_ips_global_each":0,"user_max_unique_ips_mode":"active_window","user_max_unique_ips_window_secs":30,"cidr_rate_limits":{}},"runtime":{"active_generation":2,"config_epoch":6,"runtime_match":"2a8c5c0c28168a0997bc3a368a12549c:2:6"},"published_match":true,"effective_scope":"active_config_snapshot","subsystem_convergence":"unknown","apply_mode":"watcher"}}`))
		return w.Result(), nil
	})
	patch := AccessPolicyPatch{"user_max_tcp_conns_global_each": json.RawMessage(`1`)}
	if _, _, err := c.PatchAccessPolicy(context.Background(), patch, "s1", "r1"); err != nil {
		t.Fatal(err)
	}
	if got := deadlines[0]; got < ConfigMutationTimeout-time.Second || got > ConfigMutationTimeout {
		t.Errorf("policy preparation deadline=%s, want bounded %s", got, ConfigMutationTimeout)
	}
	if _, _, err := c.AccessPolicy(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := deadlines[1]; got < 14*time.Second || got > 15*time.Second {
		t.Errorf("ordinary read deadline=%s, want 15s", got)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, _, err := c.PatchAccessPolicy(ctx, patch, "s1", "r1"); err != nil {
		t.Fatal(err)
	}
	if got := deadlines[2]; got < 500*time.Millisecond || got > time.Second {
		t.Errorf("caller deadline not retained: %s", got)
	}
	if c.http.Timeout != 15*time.Second {
		t.Errorf("shared client timeout changed: %s", c.http.Timeout)
	}
}
