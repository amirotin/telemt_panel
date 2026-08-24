package host

import (
	"context"
	"errors"
	"testing"
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
