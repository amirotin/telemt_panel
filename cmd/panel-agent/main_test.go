package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/host"
)

// buildAgent compiles the real cmd/panel-agent binary once per test
// process (subsequent calls reuse the cached binary) — the contract test
// needs to run the actual thing that will ship, not a fake, since it's
// specifically proving the compiled binary's allow-list enforcement and
// framing.
var buildOnce = sync.OnceValues(func() (string, error) {
	dir, err := os.MkdirTemp("", "panel-agent-build-")
	if err != nil {
		return "", err
	}
	bin := filepath.Join(dir, "panel-agent")
	cmd := exec.Command("go", "build", "-o", bin, ".")
	cmd.Dir = "."
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", &buildError{out: out, err: err}
	}
	return bin, nil
})

type buildError struct {
	out []byte
	err error
}

func (e *buildError) Error() string { return string(e.out) + ": " + e.err.Error() }

// auditLine is the shape of one cmd/panel-agent JSON log record, enough
// to find the "listening" readiness line and to assert on op audit
// entries.
type auditLine struct {
	Msg     string `json:"msg"`
	Socket  string `json:"socket"`
	Kind    string `json:"kind"`
	Arg     string `json:"arg"`
	Service string `json:"service_manager"`
}

// agentProcess wraps a running panel-agent subprocess and the socket it
// listens on, plus the parsed stream of its stderr audit log lines.
type agentProcess struct {
	t      *testing.T
	cmd    *exec.Cmd
	socket string

	mu    sync.Mutex
	lines []auditLine
}

// startAgent builds (once) and starts panel-agent with the given
// allow-lists on a fresh temp socket, blocking until the agent's own
// "listening" audit line confirms it's actually accepting connections —
// no sleep/poll needed, the readiness signal is the real event.
func startAgent(t *testing.T, allowDest, allowService []string) *agentProcess {
	t.Helper()
	bin, err := buildOnce()
	if err != nil {
		t.Fatalf("build panel-agent: %v", err)
	}

	socket := filepath.Join(t.TempDir(), "agent.sock")
	args := []string{"-socket", socket}
	for _, d := range allowDest {
		args = append(args, "-allow-dest", d)
	}
	for _, s := range allowService {
		args = append(args, "-allow-service", s)
	}
	cmd := exec.Command(bin, args...)
	stderr, err := cmd.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start panel-agent: %v", err)
	}

	ap := &agentProcess{t: t, cmd: cmd, socket: socket}
	ready := make(chan struct{})
	go ap.drainStderr(stderr, ready)

	select {
	case <-ready:
	case <-time.After(10 * time.Second):
		cmd.Process.Kill()
		t.Fatal("panel-agent never logged \"listening\"")
	}
	return ap
}

// drainStderr continuously scans the agent's JSON audit log, recording
// every line and closing ready the first time it sees "listening" — kept
// running for the process's whole life so the pipe never fills and blocks
// the child.
func (ap *agentProcess) drainStderr(r io.Reader, ready chan struct{}) {
	scanner := bufio.NewScanner(r)
	signaled := false
	for scanner.Scan() {
		var line auditLine
		if err := json.Unmarshal(scanner.Bytes(), &line); err != nil {
			continue
		}
		ap.mu.Lock()
		ap.lines = append(ap.lines, line)
		ap.mu.Unlock()
		if !signaled && line.Msg == "listening" {
			signaled = true
			close(ready)
		}
	}
}

// opLines returns every audit line logged with msg=="op", the ones
// asserting kind+primary-arg-only auditing checks against.
func (ap *agentProcess) opLines() []auditLine {
	ap.mu.Lock()
	defer ap.mu.Unlock()
	var out []auditLine
	for _, l := range ap.lines {
		if l.Msg == "op" {
			out = append(out, l)
		}
	}
	return out
}

// stopGracefully sends SIGTERM and waits for a clean exit, proving the
// brief's "graceful shutdown on SIGTERM" requirement.
func (ap *agentProcess) stopGracefully() error {
	if err := ap.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- ap.cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-time.After(10 * time.Second):
		ap.t.Fatal("panel-agent did not exit within 10s of SIGTERM")
		return nil
	}
}

// call dials ap's socket, sends op framed as JSON, and returns the parsed
// AgentResponse.
func call(t *testing.T, socket string, op host.Op) host.AgentResponse {
	t.Helper()
	conn, err := net.DialTimeout("unix", socket, 3*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(5 * time.Second))

	payload, err := json.Marshal(op)
	if err != nil {
		t.Fatal(err)
	}
	if err := host.WriteFrame(conn, payload); err != nil {
		t.Fatalf("write frame: %v", err)
	}
	respPayload, err := host.ReadFrame(conn)
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	var resp host.AgentResponse
	if err := json.Unmarshal(respPayload, &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	return resp
}

func TestPanelAgent_AllowedOpOnTempFileSucceeds(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "telemt.toml")
	os.WriteFile(target, []byte("old = true\n"), 0o600)

	ap := startAgent(t, []string{target}, nil)
	defer ap.stopGracefully()

	resp := call(t, ap.socket, host.Op{Kind: host.OpWriteConfig, Args: map[string]string{
		host.ArgPath: target, host.ArgContent: "new = true\n",
	}})
	if !resp.OK {
		t.Fatalf("response = %+v, want ok", resp)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new = true\n" {
		t.Errorf("file content = %q", got)
	}

	ops := ap.opLines()
	if len(ops) != 1 || ops[0].Kind != host.OpWriteConfig || ops[0].Arg != target {
		t.Errorf("audit log ops = %+v", ops)
	}
}

func TestPanelAgent_DisallowedKindRejected(t *testing.T) {
	ap := startAgent(t, nil, nil)
	defer ap.stopGracefully()

	resp := call(t, ap.socket, host.Op{Kind: "delete-everything", Args: map[string]string{}})
	if resp.OK {
		t.Fatal("want ok:false for an unknown op kind")
	}
	if resp.Error == "" {
		t.Error("want a non-empty error explaining the rejection")
	}
}

func TestPanelAgent_DisallowedDestRejected(t *testing.T) {
	dir := t.TempDir()
	staging := filepath.Join(dir, "staging")
	os.WriteFile(staging, []byte("x"), 0o644)
	dest := filepath.Join(dir, "telemt") // not passed to -allow-dest

	ap := startAgent(t, []string{filepath.Join(dir, "other-allowed")}, nil)
	defer ap.stopGracefully()

	resp := call(t, ap.socket, host.Op{Kind: host.OpInstallBinary, Args: map[string]string{
		host.ArgStaging: staging, host.ArgDest: dest,
	}})
	if resp.OK {
		t.Fatal("want ok:false for a dest outside --allow-dest")
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Error("dest must not have been written")
	}
}

func TestPanelAgent_DisallowedServiceRejected(t *testing.T) {
	ap := startAgent(t, nil, []string{"telemt"})
	defer ap.stopGracefully()

	resp := call(t, ap.socket, host.Op{Kind: host.OpRestartService, Args: map[string]string{
		host.ArgService: "nginx",
	}})
	if resp.OK {
		t.Fatal("want ok:false for a service outside --allow-service")
	}
	if !strings.Contains(resp.Error, "nginx") {
		t.Errorf("error %q doesn't name the rejected service", resp.Error)
	}
}

func TestPanelAgent_MalformedFrameRejected(t *testing.T) {
	ap := startAgent(t, nil, nil)
	defer ap.stopGracefully()

	conn, err := net.DialTimeout("unix", ap.socket, 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(5 * time.Second))

	garbage := []byte("this is not json")
	if err := host.WriteFrame(conn, garbage); err != nil {
		t.Fatal(err)
	}
	respPayload, err := host.ReadFrame(conn)
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	var resp host.AgentResponse
	if err := json.Unmarshal(respPayload, &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if resp.OK {
		t.Fatal("want ok:false for a malformed (non-JSON) frame payload")
	}
}

func TestPanelAgent_OversizedFrameRejected(t *testing.T) {
	ap := startAgent(t, nil, nil)
	defer ap.stopGracefully()

	conn, err := net.DialTimeout("unix", ap.socket, 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(5 * time.Second))

	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], host.MaxFrameBytes+1)
	if _, err := conn.Write(hdr[:]); err != nil {
		t.Fatal(err)
	}
	// No body follows — the agent must reject based on the declared
	// length alone and close the connection, not hang waiting for bytes
	// that were never going to arrive.
	buf := make([]byte, 1)
	if _, err := conn.Read(buf); err == nil {
		t.Fatal("want the connection closed (read error), got a byte back")
	}
}

func TestPanelAgent_GracefulShutdownOnSIGTERM(t *testing.T) {
	ap := startAgent(t, nil, nil)
	if err := ap.stopGracefully(); err != nil {
		t.Errorf("panel-agent did not exit cleanly on SIGTERM: %v", err)
	}
}

func TestPanelAgent_RemovesStaleSocketOnStart(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "agent.sock")
	// A stale regular file left at the socket path (e.g. from an unclean
	// previous shutdown) must not block the new listener.
	if err := os.WriteFile(socket, []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}

	bin, err := buildOnce()
	if err != nil {
		t.Fatalf("build panel-agent: %v", err)
	}
	cmd := exec.Command(bin, "-socket", socket)
	stderr, err := cmd.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()

	ready := make(chan struct{})
	ap := &agentProcess{t: t, cmd: cmd, socket: socket}
	go ap.drainStderr(stderr, ready)
	select {
	case <-ready:
	case <-time.After(10 * time.Second):
		t.Fatal("panel-agent never logged \"listening\" despite a stale socket file")
	}

	resp := call(t, socket, host.Op{Kind: "delete-everything"})
	if resp.OK {
		t.Fatal("want ok:false")
	}
	ap.stopGracefully()
}
