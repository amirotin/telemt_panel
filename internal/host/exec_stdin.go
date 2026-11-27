package host

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"time"
)

// StdinCmdRunner executes a command with input already opened by its caller.
// The source pathname never crosses the privileged command boundary.
type StdinCmdRunner func(ctx context.Context, stdin io.Reader, name string, args ...string) (stdout, stderr []byte, err error)

const maxCommandOutputSize = 64 << 10

// OSStdinCmdRunner streams stdin into a subprocess with bounded output capture.
// Like OSCmdRunner, nonzero command exits are reported as *ExitError.
func OSStdinCmdRunner(ctx context.Context, stdin io.Reader, name string, args ...string) (stdout, stderr []byte, err error) {
	return runWithBoundedOutput(ctx, stdin, maxCommandOutputSize, false, name, args...)
}

func runWithBoundedOutput(ctx context.Context, stdin io.Reader, limit int, requireComplete bool, name string, args ...string) (stdout, stderr []byte, err error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.WaitDelay = time.Second
	cmd.Stdin = stdin
	outBuf, errBuf := boundedCommandOutput{limit: limit}, boundedCommandOutput{limit: limit}
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf
	err = cmd.Run()
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		err = &ExitError{Code: exitErr.ExitCode()}
	}
	if err == nil && requireComplete && (outBuf.truncated || errBuf.truncated) {
		err = fmt.Errorf("output of %s exceeds the capture limit of %d bytes", name, limit)
	}
	return outBuf.buffer.Bytes(), errBuf.buffer.Bytes(), err
}

type boundedCommandOutput struct {
	buffer    bytes.Buffer
	limit     int
	truncated bool
}

func (b *boundedCommandOutput) Write(p []byte) (int, error) {
	n := len(p)
	if n > b.limit-b.buffer.Len() {
		b.truncated = true
	}
	if remaining := b.limit - b.buffer.Len(); remaining > 0 {
		if len(p) > remaining {
			p = p[:remaining]
		}
		_, _ = b.buffer.Write(p)
	}
	return n, nil
}

// NewSudoStdinCmdRunner wraps a streamed command as sudo -n -- without a shell.
func NewSudoStdinCmdRunner(base StdinCmdRunner) StdinCmdRunner {
	return func(ctx context.Context, stdin io.Reader, name string, args ...string) ([]byte, []byte, error) {
		if base == nil {
			return nil, nil, errors.New("sudo stdin command runner is not configured")
		}
		sudoArgs := make([]string, 0, len(args)+3)
		sudoArgs = append(sudoArgs, "-n", "--", name)
		sudoArgs = append(sudoArgs, args...)
		return base(ctx, stdin, "sudo", sudoArgs...)
	}
}
