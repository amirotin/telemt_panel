package host

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
)

// CmdRunner executes name with args and returns its captured stdout,
// stderr and error. Every ServiceManager implementation takes one instead
// of calling os/exec directly, so tests can inject a recorder and assert
// argv without running real commands.
type CmdRunner func(ctx context.Context, name string, args ...string) (stdout, stderr []byte, err error)

// OSCmdRunner is the production CmdRunner: it runs the command via
// os/exec. A nonzero exit is reported as *ExitError rather than
// os/exec's *exec.ExitError, so callers have one exit-code type to check
// regardless of whether the runner is real or faked in tests.
func OSCmdRunner(ctx context.Context, name string, args ...string) (stdout, stderr []byte, err error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf

	err = cmd.Run()
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		err = &ExitError{Code: exitErr.ExitCode()}
	}
	return outBuf.Bytes(), errBuf.Bytes(), err
}
