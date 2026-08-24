package host

import (
	"context"
	"errors"
	"net"
	"path/filepath"
	"testing"
)

// listenTempSocket starts a unix listener on a fresh temp path and
// accepts (and immediately drops) every connection, so dialProbe/
// SelectRunner's probe dial succeeds — a stand-in for a running
// panel-agent without exercising the real agent binary (that's
// cmd/panel-agent's own contract test).
func listenTempSocket(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "agent.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			conn.Close()
		}
	}()
	return path
}

func TestSelectRunner(t *testing.T) {
	liveSocket := listenTempSocket(t)
	deadSocket := filepath.Join(t.TempDir(), "no-such-agent.sock")

	cases := []struct {
		name       string
		mode       string
		socketPath string
		euid       int
		wantType   string // "direct" | "agent" | "degraded"
	}{
		{"auto, root, no socket needed", PrivilegesModeAuto, deadSocket, 0, "direct"},
		{"auto, non-root, socket up", PrivilegesModeAuto, liveSocket, 1000, "agent"},
		{"auto, non-root, socket down", PrivilegesModeAuto, deadSocket, 1000, "degraded"},
		{"auto, empty mode string treated as auto", "", liveSocket, 1000, "agent"},
		{"direct forced despite non-root euid", PrivilegesModeDirect, deadSocket, 1000, "direct"},
		{"agent forced, socket up", PrivilegesModeAgent, liveSocket, 0, "agent"},
		{"agent forced, socket down degrades rather than erroring", PrivilegesModeAgent, deadSocket, 0, "degraded"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := SelectRunner(tc.mode, tc.socketPath, tc.euid, AllowLists{}, nil, nil)
			if r == nil {
				t.Fatal("SelectRunner must never return nil")
			}
			var gotType string
			switch r.(type) {
			case *directRunner:
				gotType = "direct"
			case *agentClient:
				gotType = "agent"
			case degradedRunner:
				gotType = "degraded"
			default:
				t.Fatalf("unexpected Runner type %T", r)
			}
			if gotType != tc.wantType {
				t.Errorf("Runner type = %s, want %s", gotType, tc.wantType)
			}
		})
	}
}

func TestSelectRunner_DegradedRunnerReturnsErrPrivilegesUnavailable(t *testing.T) {
	r := SelectRunner(PrivilegesModeAuto, filepath.Join(t.TempDir(), "gone.sock"), 1000, AllowLists{}, nil, nil)
	_, err := r.Run(context.Background(), Op{Kind: OpRestartService, Args: map[string]string{"service": "telemt"}})
	if !errors.Is(err, ErrPrivilegesUnavailable) {
		t.Errorf("err = %v, want ErrPrivilegesUnavailable", err)
	}
}

func TestDialProbe(t *testing.T) {
	live := listenTempSocket(t)
	if !dialProbe(live) {
		t.Error("dialProbe(live) = false, want true")
	}
	if dialProbe(filepath.Join(t.TempDir(), "nope.sock")) {
		t.Error("dialProbe(nonexistent) = true, want false")
	}
	if dialProbe("") {
		t.Error("dialProbe(\"\") = true, want false")
	}
}
