package host

import "context"

// recordedCmd is one CmdRunner invocation captured by fakeRunner.
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
