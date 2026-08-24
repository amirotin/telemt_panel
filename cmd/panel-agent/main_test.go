package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
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

// agentOpts configures startAgentWithOpts. Fields left zero mean "pass
// nothing for this flag" (an empty/absent allow-list, no staging prefix,
// no --socket-group), except Socket, which defaults to a fresh temp path
// when empty.
type agentOpts struct {
	Socket        string
	BinaryPaths   []string
	ConfigPaths   []string
	StagingPrefix string
	Services      []string
	SocketGroup   string
}

// startAgentWithOpts builds (once) and starts panel-agent per opts,
// blocking until the agent's own "listening" audit line confirms it's
// actually accepting connections — no sleep/poll needed, the readiness
// signal is the real event.
func startAgentWithOpts(t *testing.T, opts agentOpts) *agentProcess {
	t.Helper()
	bin, err := buildOnce()
	if err != nil {
		t.Fatalf("build panel-agent: %v", err)
	}

	socket := opts.Socket
	if socket == "" {
		socket = filepath.Join(t.TempDir(), "agent.sock")
	}
	args := []string{"-socket", socket}
	for _, d := range opts.BinaryPaths {
		args = append(args, "-allow-binary-dest", d)
	}
	for _, c := range opts.ConfigPaths {
		args = append(args, "-allow-config-path", c)
	}
	if opts.StagingPrefix != "" {
		args = append(args, "-staging-prefix", opts.StagingPrefix)
	}
	for _, s := range opts.Services {
		args = append(args, "-allow-service", s)
	}
	if opts.SocketGroup != "" {
		args = append(args, "-socket-group", opts.SocketGroup)
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

// startAgent is the common-case convenience wrapper: an install/restore
// dest allow-list plus a service allow-list, no staging prefix or config
// paths.
func startAgent(t *testing.T, binaryPaths, services []string) *agentProcess {
	return startAgentWithOpts(t, agentOpts{BinaryPaths: binaryPaths, Services: services})
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

	ap := startAgentWithOpts(t, agentOpts{ConfigPaths: []string{target}})
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
	stagingDir := filepath.Join(dir, "staging")
	os.MkdirAll(stagingDir, 0o755)
	staging := filepath.Join(stagingDir, "staging")
	os.WriteFile(staging, []byte("x"), 0o644)
	dest := filepath.Join(dir, "telemt") // not passed to -allow-binary-dest

	ap := startAgentWithOpts(t, agentOpts{
		BinaryPaths:   []string{filepath.Join(dir, "other-allowed")},
		StagingPrefix: stagingDir,
	})
	defer ap.stopGracefully()

	resp := call(t, ap.socket, host.Op{Kind: host.OpInstallBinary, Args: map[string]string{
		host.ArgStaging: staging, host.ArgDest: dest,
	}})
	if resp.OK {
		t.Fatal("want ok:false for a dest outside --allow-binary-dest")
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Error("dest must not have been written")
	}
}

// TestPanelAgent_StagingOutsidePrefixRejected is FINDING 1's contract-level
// regression test: with dest allow-listed but staging outside
// --staging-prefix, the real binary must still refuse the op — otherwise
// an authorized client could make the root agent read any file it can
// access and copy it into the allow-listed dest.
func TestPanelAgent_StagingOutsidePrefixRejected(t *testing.T) {
	dir := t.TempDir()
	stagingDir := filepath.Join(dir, "staging")
	os.MkdirAll(stagingDir, 0o755)
	outsideStaging := filepath.Join(dir, "not-staging", "secret")
	os.MkdirAll(filepath.Dir(outsideStaging), 0o755)
	os.WriteFile(outsideStaging, []byte("secret bytes"), 0o600)
	dest := filepath.Join(dir, "telemt")

	ap := startAgentWithOpts(t, agentOpts{
		BinaryPaths:   []string{dest},
		StagingPrefix: stagingDir,
	})
	defer ap.stopGracefully()

	resp := call(t, ap.socket, host.Op{Kind: host.OpInstallBinary, Args: map[string]string{
		host.ArgStaging: outsideStaging, host.ArgDest: dest,
	}})
	if resp.OK {
		t.Fatal("want ok:false for a staging path outside --staging-prefix")
	}
	if !strings.Contains(resp.Error, "staging prefix") {
		t.Errorf("error %q doesn't explain the staging-prefix rejection", resp.Error)
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Error("dest must not have been written")
	}
}

// TestPanelAgent_BinaryAndConfigPathsAreNotCrossAddressable is FINDING
// 2's contract-level regression test: a path allow-listed for one
// purpose must not validate for the other, through the real binary.
func TestPanelAgent_BinaryAndConfigPathsAreNotCrossAddressable(t *testing.T) {
	dir := t.TempDir()
	stagingDir := filepath.Join(dir, "staging")
	os.MkdirAll(stagingDir, 0o755)
	staging := filepath.Join(stagingDir, "s")
	os.WriteFile(staging, []byte("x"), 0o644)

	binaryDest := filepath.Join(dir, "telemt")
	configPath := filepath.Join(dir, "telemt.toml")
	os.WriteFile(configPath, []byte("old"), 0o600)

	ap := startAgentWithOpts(t, agentOpts{
		BinaryPaths:   []string{binaryDest},
		ConfigPaths:   []string{configPath},
		StagingPrefix: stagingDir,
	})
	defer ap.stopGracefully()

	resp := call(t, ap.socket, host.Op{Kind: host.OpInstallBinary, Args: map[string]string{
		host.ArgStaging: staging, host.ArgDest: configPath,
	}})
	if resp.OK {
		t.Fatal("want ok:false: a --allow-config-path entry must not be install-binary-addressable")
	}

	resp = call(t, ap.socket, host.Op{Kind: host.OpWriteConfig, Args: map[string]string{
		host.ArgPath: binaryDest, host.ArgContent: "malicious",
	}})
	if resp.OK {
		t.Fatal("want ok:false: a --allow-binary-dest entry must not be write-config-addressable")
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

// TestPanelAgent_DoubleStartRefusesWhenLiveAgentPresent is FINDING 4's
// regression test: a second start pointed at the same socket while the
// first instance is still live must refuse rather than remove the live
// socket out from under it, and the first instance must keep working
// afterward (proof it was never touched).
func TestPanelAgent_DoubleStartRefusesWhenLiveAgentPresent(t *testing.T) {
	ap := startAgent(t, nil, nil)
	defer ap.stopGracefully()

	bin, err := buildOnce()
	if err != nil {
		t.Fatalf("build panel-agent: %v", err)
	}
	out, err := exec.Command(bin, "-socket", ap.socket).CombinedOutput()
	if err == nil {
		t.Fatal("want the second panel-agent start to fail while the first is live")
	}
	if !strings.Contains(string(out), "already running") {
		t.Errorf("second start's output = %q, want it to mention \"already running\"", out)
	}

	// The first instance must still be alive and responsive — the second
	// start must not have removed or otherwise disturbed its socket.
	resp := call(t, ap.socket, host.Op{Kind: "delete-everything"})
	if resp.OK {
		t.Fatal("want ok:false (first instance still enforcing its allow-list)")
	}
}

// TestPanelAgent_SocketGroupSetsGroupOwnershipAndMode is FINDING 3's
// verification: with --socket-group set, the socket dir/file switch to
// the group-accessible 0750/0660 profile and take on that group's
// ownership. Uses the test process's own primary group (a non-root
// process can chgrp a file it owns to any group it belongs to) so this
// runs without requiring root.
func TestPanelAgent_SocketGroupSetsGroupOwnershipAndMode(t *testing.T) {
	u, err := user.Current()
	if err != nil {
		t.Skipf("cannot determine current user: %v", err)
	}
	grp, err := user.LookupGroupId(u.Gid)
	if err != nil {
		t.Skipf("cannot resolve primary group name: %v", err)
	}
	wantGid, err := strconv.Atoi(grp.Gid)
	if err != nil {
		t.Skipf("primary group gid %q not numeric", grp.Gid)
	}

	ap := startAgentWithOpts(t, agentOpts{SocketGroup: grp.Name})
	defer ap.stopGracefully()

	dirInfo, err := os.Stat(filepath.Dir(ap.socket))
	if err != nil {
		t.Fatal(err)
	}
	if dirInfo.Mode().Perm() != 0o750 {
		t.Errorf("socket dir mode = %v, want 0750", dirInfo.Mode().Perm())
	}
	sockInfo, err := os.Stat(ap.socket)
	if err != nil {
		t.Fatal(err)
	}
	if sockInfo.Mode().Perm() != 0o660 {
		t.Errorf("socket file mode = %v, want 0660", sockInfo.Mode().Perm())
	}
	sys, ok := sockInfo.Sys().(*syscall.Stat_t)
	if !ok {
		t.Fatal("Sys() is not *syscall.Stat_t on this platform")
	}
	if int(sys.Gid) != wantGid {
		t.Errorf("socket gid = %d, want %d (%s)", sys.Gid, wantGid, grp.Name)
	}
}

// TestPanelAgent_DefaultSocketIsRootOnlyMode is the counterpart to the
// --socket-group test: with the flag unset, the socket stays on the
// original root-only 0700/0600 profile.
func TestPanelAgent_DefaultSocketIsRootOnlyMode(t *testing.T) {
	ap := startAgent(t, nil, nil)
	defer ap.stopGracefully()

	dirInfo, err := os.Stat(filepath.Dir(ap.socket))
	if err != nil {
		t.Fatal(err)
	}
	if dirInfo.Mode().Perm() != 0o700 {
		t.Errorf("socket dir mode = %v, want 0700", dirInfo.Mode().Perm())
	}
	sockInfo, err := os.Stat(ap.socket)
	if err != nil {
		t.Fatal(err)
	}
	if sockInfo.Mode().Perm() != 0o600 {
		t.Errorf("socket file mode = %v, want 0600", sockInfo.Mode().Perm())
	}
}
