package host

import (
	"context"
	"encoding/json"
	"net"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// serveOneOp starts a unix listener at path, accepts exactly one
// connection, reads one framed Op request and hands it to handler, then
// writes handler's AgentResponse back framed — a minimal hand-rolled
// server exercising agentClient.Run's own logic (marshal/frame/parse)
// independent of the real cmd/panel-agent binary, which has its own
// contract test.
func serveOneOp(t *testing.T, handler func(Op) AgentResponse) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "agent.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		payload, err := ReadFrame(conn)
		if err != nil {
			return
		}
		var op Op
		if err := json.Unmarshal(payload, &op); err != nil {
			return
		}
		resp := handler(op)
		out, _ := json.Marshal(resp)
		WriteFrame(conn, out)
	}()
	return path
}

func TestAgentClient_Run_Success(t *testing.T) {
	var gotOp Op
	socket := serveOneOp(t, func(op Op) AgentResponse {
		gotOp = op
		return AgentResponse{OK: true, Stdout: "installed"}
	})

	c := NewAgentClient(socket)
	out, err := c.Run(context.Background(), Op{Kind: OpInstallBinary, Args: map[string]string{ArgStaging: "/tmp/a", ArgDest: "/bin/telemt"}})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if out.Stdout != "installed" {
		t.Errorf("Stdout = %q", out.Stdout)
	}
	if gotOp.Kind != OpInstallBinary || gotOp.Args[ArgDest] != "/bin/telemt" {
		t.Errorf("server saw op = %+v", gotOp)
	}
}

func TestAgentClient_Run_ErrorReply(t *testing.T) {
	socket := serveOneOp(t, func(op Op) AgentResponse {
		return AgentResponse{OK: false, Error: "service not in the allowed service list"}
	})

	c := NewAgentClient(socket)
	_, err := c.Run(context.Background(), Op{Kind: OpRestartService, Args: map[string]string{ArgService: "nginx"}})
	if err == nil {
		t.Fatal("want error, got nil")
	}
	if !strings.Contains(err.Error(), "service not in the allowed service list") {
		t.Errorf("err = %v, want it to carry the agent's error text", err)
	}
}

func TestAgentClient_Run_DialFailureOnMissingSocket(t *testing.T) {
	c := NewAgentClient(filepath.Join(t.TempDir(), "nope.sock"))
	_, err := c.Run(context.Background(), Op{Kind: OpRestartService, Args: map[string]string{ArgService: "telemt"}})
	if err == nil {
		t.Fatal("want dial error, got nil")
	}
}

func TestAgentClient_Run_ContextCancellationEndsRunPromptly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	// Accept and then hang: never reads or replies, forcing Run to rely on
	// ctx cancellation rather than a normal response to return.
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		<-context.Background().Done() // never
		conn.Close()
	}()

	c := NewAgentClient(path) // per-kind deadline (90s for restart-service) is deliberately long; ctx must be what ends Run
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := c.Run(ctx, Op{Kind: OpRestartService, Args: map[string]string{ArgService: "telemt"}})
		done <- err
	}()
	cancel()

	select {
	case err := <-done:
		if err == nil {
			t.Error("want error after ctx cancellation, got nil")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return promptly after ctx cancellation")
	}
}

func TestAgentClient_Run_MalformedReplyJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		if _, err := ReadFrame(conn); err != nil {
			return
		}
		WriteFrame(conn, []byte("not json"))
	}()

	c := NewAgentClient(path)
	_, err = c.Run(context.Background(), Op{Kind: OpRestartService, Args: map[string]string{ArgService: "telemt"}})
	if err == nil {
		t.Fatal("want error for a malformed reply, got nil")
	}
}

// TestAgentOpTimeoutFor_PerKindDeadlines covers P2.8: each Op.Kind gets its
// own named deadline (agent_client.go), not one flat timeout — the slow
// file-copy ops get the most headroom, the quick bounded ops the least.
func TestAgentOpTimeoutFor_PerKindDeadlines(t *testing.T) {
	tests := []struct {
		kind string
		want time.Duration
	}{
		{OpInstallBinary, 120 * time.Second},
		{OpRestoreBinary, 120 * time.Second},
		{OpRestartService, 90 * time.Second},
		{OpReadJournal, 30 * time.Second},
		{OpWriteConfig, 30 * time.Second},
		{"unknown-kind", defaultAgentOpTimeout},
	}
	for _, tc := range tests {
		t.Run(tc.kind, func(t *testing.T) {
			if got := agentOpTimeoutFor(tc.kind); got != tc.want {
				t.Errorf("agentOpTimeoutFor(%q) = %v, want %v", tc.kind, got, tc.want)
			}
		})
	}
}

// TestAgentClient_Run_CallerCtxDeadlineShorterThanOpTimeoutWins covers
// P2.8's other half: a caller-supplied ctx deadline shorter than the op's
// own (much larger) per-kind timeout must be what actually bounds Run —
// proven here against install-binary's 120s deadline, using a server that
// never replies so only the ctx deadline (a few tens of milliseconds) can
// end the call.
func TestAgentClient_Run_CallerCtxDeadlineShorterThanOpTimeoutWins(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	// Accept and then hang: never reads or replies, so only the ctx
	// deadline below (not a normal response, not ctx cancellation) can end
	// Run — proving it, not install-binary's 120s default, is what bounds
	// the call.
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		<-context.Background().Done() // never
		conn.Close()
	}()

	c := NewAgentClient(path)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	done := make(chan error, 1)
	go func() {
		_, err := c.Run(ctx, Op{Kind: OpInstallBinary, Args: map[string]string{ArgStaging: "/tmp/a", ArgDest: "/bin/telemt"}})
		done <- err
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Error("want error once the short ctx deadline passes, got nil")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after its ctx deadline — the 120s install-binary timeout must have won instead")
	}
}
