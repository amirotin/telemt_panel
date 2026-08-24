// Package hosttest provides scriptable, call-recording fakes of the
// internal/host interfaces for tests in other packages (update engine,
// httpapi) that depend on host.ServiceManager or host.LogSource without
// touching a real host.
package hosttest

import (
	"context"
	"sync"

	"github.com/amirotin/telemt_panel/internal/host"
)

// ServiceManager is a fake host.ServiceManager. Zero value returns
// StatusUnknown/nil errors and records every call; set the *Func fields
// (or the plain result/err fields they fall back to) to script behavior.
type ServiceManager struct {
	KindValue string
	CapsValue host.ServiceCaps

	StatusFunc   func(service string) (host.ServiceStatus, error)
	StatusResult host.ServiceStatus
	StatusErr    error

	RestartFunc func(service string) error
	RestartErr  error

	mu           sync.Mutex
	StatusCalls  []string
	RestartCalls []string
}

// Kind implements host.ServiceManager.
func (f *ServiceManager) Kind() string { return f.KindValue }

// Status implements host.ServiceManager, recording the call.
func (f *ServiceManager) Status(ctx context.Context, service string) (host.ServiceStatus, error) {
	f.mu.Lock()
	f.StatusCalls = append(f.StatusCalls, service)
	f.mu.Unlock()
	if f.StatusFunc != nil {
		return f.StatusFunc(service)
	}
	return f.StatusResult, f.StatusErr
}

// Restart implements host.ServiceManager, recording the call.
func (f *ServiceManager) Restart(ctx context.Context, service string) error {
	f.mu.Lock()
	f.RestartCalls = append(f.RestartCalls, service)
	f.mu.Unlock()
	if f.RestartFunc != nil {
		return f.RestartFunc(service)
	}
	return f.RestartErr
}

// Caps implements host.ServiceManager.
func (f *ServiceManager) Caps() host.ServiceCaps { return f.CapsValue }

// TailCall records one Tail invocation on a fake LogSource.
type TailCall struct {
	Service string
	Lines   int
}

// LogSource is a fake host.LogSource. Zero value returns empty
// results/nil errors and records every call; set the *Func fields (or the
// plain result/err fields they fall back to) to script behavior. When
// StreamFunc is nil, Stream pushes StreamResult onto a channel and closes
// it, stopping early if ctx is done.
type LogSource struct {
	KindValue string
	CapsValue host.LogCaps

	TailFunc   func(service string, lines int) ([]host.LogLine, error)
	TailResult []host.LogLine
	TailErr    error

	StreamFunc   func(ctx context.Context, service string) (<-chan host.LogLine, error)
	StreamResult []host.LogLine
	StreamErr    error

	mu          sync.Mutex
	TailCalls   []TailCall
	StreamCalls []string
}

// Kind implements host.LogSource.
func (f *LogSource) Kind() string { return f.KindValue }

// Tail implements host.LogSource, recording the call.
func (f *LogSource) Tail(ctx context.Context, service string, lines int) ([]host.LogLine, error) {
	f.mu.Lock()
	f.TailCalls = append(f.TailCalls, TailCall{Service: service, Lines: lines})
	f.mu.Unlock()
	if f.TailFunc != nil {
		return f.TailFunc(service, lines)
	}
	return f.TailResult, f.TailErr
}

// Stream implements host.LogSource, recording the call.
func (f *LogSource) Stream(ctx context.Context, service string) (<-chan host.LogLine, error) {
	f.mu.Lock()
	f.StreamCalls = append(f.StreamCalls, service)
	f.mu.Unlock()
	if f.StreamFunc != nil {
		return f.StreamFunc(ctx, service)
	}
	if f.StreamErr != nil {
		return nil, f.StreamErr
	}
	ch := make(chan host.LogLine)
	go func() {
		defer close(ch)
		for _, line := range f.StreamResult {
			select {
			case ch <- line:
			case <-ctx.Done():
				return
			}
		}
	}()
	return ch, nil
}

// Caps implements host.LogSource.
func (f *LogSource) Caps() host.LogCaps { return f.CapsValue }

// Runner is a fake host.Runner for tests (the update engine, httpapi) that
// need to script or inspect privileged-op execution without a real direct
// or agent Runner. Zero value returns Output{}, nil for every call and
// records it; set RunFunc (or the plain Result/Err fields it falls back
// to) to script behavior.
type Runner struct {
	RunFunc func(op host.Op) (host.Output, error)
	Result  host.Output
	Err     error

	mu    sync.Mutex
	Calls []host.Op
}

// Run implements host.Runner, recording the call.
func (f *Runner) Run(ctx context.Context, op host.Op) (host.Output, error) {
	f.mu.Lock()
	f.Calls = append(f.Calls, op)
	f.mu.Unlock()
	if f.RunFunc != nil {
		return f.RunFunc(op)
	}
	return f.Result, f.Err
}

// CallsSnapshot returns a copy of the ops recorded so far, safe to read
// concurrently with in-flight Run calls.
func (f *Runner) CallsSnapshot() []host.Op {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]host.Op, len(f.Calls))
	copy(out, f.Calls)
	return out
}
