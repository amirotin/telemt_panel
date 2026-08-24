package hosttest

import (
	"context"
	"errors"
	"testing"

	"github.com/amirotin/telemt_panel/internal/host"
)

// Compile-time checks that the fakes satisfy the interfaces they stand in
// for.
var (
	_ host.ServiceManager = (*ServiceManager)(nil)
	_ host.LogSource      = (*LogSource)(nil)
)

func TestServiceManager_RecordsCallsAndScriptsResults(t *testing.T) {
	wantErr := errors.New("boom")
	f := &ServiceManager{
		KindValue:    "fake",
		CapsValue:    host.ServiceCaps{CanRestart: true, CanStatus: true},
		StatusResult: host.StatusRunning,
		RestartErr:   wantErr,
	}

	if got := f.Kind(); got != "fake" {
		t.Errorf("Kind() = %q, want %q", got, "fake")
	}

	status, err := f.Status(context.Background(), "telemt")
	if err != nil || status != host.StatusRunning {
		t.Errorf("Status() = (%q, %v), want (%q, nil)", status, err, host.StatusRunning)
	}

	if err := f.Restart(context.Background(), "telemt"); !errors.Is(err, wantErr) {
		t.Errorf("Restart() = %v, want %v", err, wantErr)
	}

	if got := f.StatusCalls; len(got) != 1 || got[0] != "telemt" {
		t.Errorf("StatusCalls = %v, want [telemt]", got)
	}
	if got := f.RestartCalls; len(got) != 1 || got[0] != "telemt" {
		t.Errorf("RestartCalls = %v, want [telemt]", got)
	}
	if f.Caps() != f.CapsValue {
		t.Errorf("Caps() = %+v, want %+v", f.Caps(), f.CapsValue)
	}
}

func TestServiceManager_FuncOverridesResult(t *testing.T) {
	f := &ServiceManager{
		StatusFunc: func(service string) (host.ServiceStatus, error) {
			if service == "telemt" {
				return host.StatusStopped, nil
			}
			return host.StatusUnknown, nil
		},
	}
	got, _ := f.Status(context.Background(), "telemt")
	if got != host.StatusStopped {
		t.Errorf("Status() = %q, want %q", got, host.StatusStopped)
	}
}

func TestLogSource_RecordsCallsAndScriptsResults(t *testing.T) {
	lines := []host.LogLine{{Msg: "hello"}}
	f := &LogSource{
		KindValue:  "fake",
		CapsValue:  host.LogCaps{CanTail: true, CanStream: true},
		TailResult: lines,
	}

	got, err := f.Tail(context.Background(), "telemt", 50)
	if err != nil || len(got) != 1 || got[0].Msg != "hello" {
		t.Errorf("Tail() = (%v, %v), want ([hello], nil)", got, err)
	}
	if len(f.TailCalls) != 1 || f.TailCalls[0] != (TailCall{Service: "telemt", Lines: 50}) {
		t.Errorf("TailCalls = %v, want [{telemt 50}]", f.TailCalls)
	}
}

func TestLogSource_Stream_PushesResultAndCloses(t *testing.T) {
	f := &LogSource{StreamResult: []host.LogLine{{Msg: "a"}, {Msg: "b"}}}

	ch, err := f.Stream(context.Background(), "telemt")
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	var got []string
	for line := range ch {
		got = append(got, line.Msg)
	}
	if len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Errorf("got %v, want [a b]", got)
	}
	if len(f.StreamCalls) != 1 || f.StreamCalls[0] != "telemt" {
		t.Errorf("StreamCalls = %v, want [telemt]", f.StreamCalls)
	}
}

func TestLogSource_Stream_StopsOnContextCancel(t *testing.T) {
	// A result slice too big to fit the unbuffered send loop's channel
	// buffer forces the goroutine to block on send, so cancel must be
	// observed via the select rather than the loop draining naturally.
	lines := make([]host.LogLine, 1000)
	f := &LogSource{StreamResult: lines}

	ctx, cancel := context.WithCancel(context.Background())
	ch, err := f.Stream(ctx, "telemt")
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	<-ch // drain one to prove the goroutine started
	cancel()
	// Channel must close even though not all lines were sent.
	for range ch {
	}
}

func TestLogSource_Stream_ReturnsErr(t *testing.T) {
	wantErr := errors.New("no such service")
	f := &LogSource{StreamErr: wantErr}

	_, err := f.Stream(context.Background(), "telemt")
	if !errors.Is(err, wantErr) {
		t.Errorf("err = %v, want %v", err, wantErr)
	}
}
