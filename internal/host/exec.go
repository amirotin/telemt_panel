package host

import (
	"bytes"
	"context"
	"errors"
	"io"
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

// ProcessStarter starts a long-running command (journalctl -f, logread -f,
// docker logs -f) and returns its combined stdout+stderr as a stream. Log
// streaming needs this instead of CmdRunner because the command never
// exits on its own — CmdRunner's Run-to-completion-then-return-buffers
// shape doesn't fit. Every LogSource's Stream takes one instead of calling
// os/exec directly, so tests can feed a pipe instead of spawning a real
// process. Closing the returned ReadCloser must promptly end the command
// (production: killing the process via ctx cancellation).
type ProcessStarter func(ctx context.Context, name string, args ...string) (io.ReadCloser, error)

// OSProcessStarter is the production ProcessStarter: it starts the command
// via exec.CommandContext (ctx cancellation kills the process) with stdout
// and stderr both routed to one pipe. os/exec detects when Stdout and
// Stderr point at the same Writer and copies through a single goroutine, so
// this doesn't race the way two independent copies to a shared writer
// would. The pipe's write end closes once Wait returns, which is what
// turns process exit (including a ctx-triggered kill) into EOF for the
// reader.
func OSProcessStarter(ctx context.Context, name string, args ...string) (io.ReadCloser, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	pr, pw := io.Pipe()
	cmd.Stdout = pw
	cmd.Stderr = pw
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	go func() {
		pw.CloseWithError(cmd.Wait())
	}()
	return pr, nil
}
