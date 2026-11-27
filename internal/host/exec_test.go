package host

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"
)

// OSCmdRunner is the one piece of this package that legitimately execs a
// real process — everything else (managers, detection) takes an injected
// CmdRunner precisely so it doesn't have to. `true`/`false` are used
// because they exist on every Linux system this panel targets.

func TestOSCmdRunner_Success(t *testing.T) {
	stdout, _, err := OSCmdRunner(context.Background(), "true")
	if err != nil {
		t.Fatalf("OSCmdRunner: %v", err)
	}
	if len(stdout) != 0 {
		t.Errorf("stdout = %q, want empty", stdout)
	}
}

func TestOSCmdRunner_NonzeroExit_ReturnsExitError(t *testing.T) {
	_, _, err := OSCmdRunner(context.Background(), "false")
	var exitErr *ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("err = %v (%T), want *ExitError", err, err)
	}
	if exitErr.Code != 1 {
		t.Errorf("Code = %d, want 1", exitErr.Code)
	}
}

func TestOSCmdRunner_CapturesStdout(t *testing.T) {
	stdout, _, err := OSCmdRunner(context.Background(), "echo", "-n", "hello")
	if err != nil {
		t.Fatalf("OSCmdRunner: %v", err)
	}
	if string(stdout) != "hello" {
		t.Errorf("stdout = %q, want %q", stdout, "hello")
	}
}

func TestOSCmdRunner_DoesNotWaitForInheritedDaemonPipes(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	// An init script can exit while its background child still owns the capture
	// pipes. The runner must not wait for the daemon's lifetime to collect EOF.
	_, _, err := OSCmdRunner(ctx, "/bin/sh", "-c", "sleep 3 &")
	if !errors.Is(err, exec.ErrWaitDelay) && !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected a bounded output-wait error, got %v", err)
	}
}

func TestCommandStreamCloseStopsQuietProcess(t *testing.T) {
	stream, err := OSProcessStarter(t.Context(), "/bin/sh", "-c", "echo $$; exec sleep 30")
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	var pid int
	if _, err := fmt.Fscan(bufio.NewReader(stream), &pid); err != nil {
		t.Fatal(err)
	}
	if err := stream.Close(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
			return
		}
		time.Sleep(time.Millisecond * 5)
	}
	t.Fatal("quiet streaming process survived reader Close")
}

func TestLogTailKeepsRowsAfterOversizedRecord(t *testing.T) {
	raw := []byte(strings.Repeat("x", 1<<20+1) + "\n" + `{"MESSAGE":"after"}` + "\n")
	lines := parseJournaldLines(raw)
	if len(lines) != 1 || lines[0].Msg != "after" {
		t.Fatalf("tail lost following record: %v", lines)
	}
}
