package host

import (
	"context"
	"io"
)

// recordedCmd is one CmdRunner/ProcessStarter invocation captured by
// fakeRunner/fakeProcessStarter.
type recordedCmd struct {
	name string
	args []string
}

// fakeRunner is a CmdRunner that records every call and, when handler is
// set, computes its response from name/args; otherwise it returns the
// fixed stdout/stderr/err fields. Manager tests use this instead of
// executing real commands.
type fakeRunner struct {
	calls   []recordedCmd
	handler func(name string, args []string) (stdout, stderr []byte, err error)
	stdout  []byte
	stderr  []byte
	err     error
}

func (f *fakeRunner) run(_ context.Context, name string, args ...string) ([]byte, []byte, error) {
	f.calls = append(f.calls, recordedCmd{name: name, args: append([]string(nil), args...)})
	if f.handler != nil {
		return f.handler(name, args)
	}
	return f.stdout, f.stderr, f.err
}

// fakeProcessStarter is a ProcessStarter that records every call and
// returns the fixed reader/err fields — LogSource Stream tests use this
// instead of spawning a real long-lived process. Tests that need to
// control timing (e.g. proving cancellation stops the reading goroutine)
// pass the reader side of an io.Pipe() as reader and write to the writer
// side themselves.
type fakeProcessStarter struct {
	calls  []recordedCmd
	reader io.ReadCloser
	err    error
}

func (f *fakeProcessStarter) start(_ context.Context, name string, args ...string) (io.ReadCloser, error) {
	f.calls = append(f.calls, recordedCmd{name: name, args: append([]string(nil), args...)})
	if f.err != nil {
		return nil, f.err
	}
	return f.reader, nil
}
