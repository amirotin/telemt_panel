package host

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCommandLogStreamsReportTerminalErrorAfterLines(t *testing.T) {
	for _, kind := range []string{"journald", "docker", "logread"} {
		t.Run(kind, func(t *testing.T) {
			reader, writer := io.Pipe()
			starter := &fakeProcessStarter{reader: reader}
			var source LogSource
			raw := "service line\n"
			switch kind {
			case "journald":
				source = NewJournald(nil, starter.start)
				raw = "{\"MESSAGE\":\"service line\"}\n"
			case "docker":
				source = NewDockerLog(nil, starter.start)
			default:
				source = NewLogread(nil, starter.start)
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			events, err := source.Stream(ctx, "telemt")
			if err != nil {
				t.Fatal(err)
			}
			go func() { io.WriteString(writer, raw); writer.CloseWithError(&ExitError{Code: 7}) }()
			line := <-events
			if line.Err != nil || !strings.Contains(line.Msg, "service line") {
				t.Fatalf("first event: %+v", line)
			}
			terminal, ok := <-events
			if !ok || terminal.Err == nil {
				t.Fatal("command exit was discarded")
			}
			diagnostic := LogDiagnostic(terminal.Err)
			if diagnostic.Reason != "command_failed" || diagnostic.ExitCode == nil || *diagnostic.ExitCode != 7 {
				t.Fatalf("diagnostic: %+v", diagnostic)
			}
			if _, ok := <-events; ok {
				t.Fatal("events after terminal error")
			}
		})
	}
}

func TestLogSourceFailuresHaveSafeReasons(t *testing.T) {
	for _, test := range []struct {
		name   string
		err    error
		text   string
		reason string
	}{
		{"missing binary", &exec.Error{Name: "journalctl", Err: exec.ErrNotFound}, "", "command_missing"},
		{"file permission", &os.PathError{Op: "open", Path: "private", Err: os.ErrPermission}, "", "permission_denied"},
		{"missing file", &os.PathError{Op: "open", Path: "private", Err: os.ErrNotExist}, "", "file_missing"},
		{"timeout", context.DeadlineExceeded, "", "source_timeout"},
		{"journal permission", &ExitError{Code: 1}, "No journal files were opened due to insufficient permissions", "permission_denied"},
		{"container missing", &ExitError{Code: 1}, "Error response from daemon: No such container: telemt", "target_missing"},
		{"daemon absent", &ExitError{Code: 1}, "Cannot connect to the Docker daemon at unix:///var/run/docker.sock", "daemon_unavailable"},
		{"unknown output", &ExitError{Code: 4}, "PRIVATE_SECRET_LOG_OUTPUT", "command_failed"},
	} {
		t.Run(test.name, func(t *testing.T) {
			diagnostic := newLogSourceError(test.err, commandLogReason(test.text))
			if diagnostic.Reason != test.reason {
				t.Fatalf("reason %q, want %q", diagnostic.Reason, test.reason)
			}
			if strings.Contains(diagnostic.Error(), "PRIVATE") || strings.Contains(diagnostic.Error(), "private") {
				t.Fatal("unsafe diagnostic text")
			}
		})
	}
}

func TestJournaldEmptyAndCommandCancellationAreNotFailures(t *testing.T) {
	runner := &fakeRunner{}
	lines, err := NewJournald(runner.run, nil).Tail(context.Background(), "unknown-unit", 20)
	if err != nil || len(lines) != 0 {
		t.Fatalf("empty journal: %v %v", lines, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	reader, writer := io.Pipe()
	events, err := NewJournald(nil, (&fakeProcessStarter{reader: reader}).start).Stream(ctx, "telemt")
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	writer.CloseWithError(&ExitError{Code: -1})
	if event, ok := <-events; ok {
		t.Fatalf("cancellation emitted a source failure: %+v", event)
	}
}

func TestCommandLogScannerFailureIsReported(t *testing.T) {
	reader := io.NopCloser(strings.NewReader(strings.Repeat("x", (1<<20)+1)))
	source := NewDockerLog(nil, (&fakeProcessStarter{reader: reader}).start)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	events, err := source.Stream(ctx, "telemt")
	if err != nil {
		t.Fatal(err)
	}
	if event, ok := <-events; !ok || event.Err == nil || LogDiagnostic(event.Err).Reason != "read_failed" {
		t.Fatal("scanner failure was hidden")
	}
}

func TestFileRuntimeDisappearanceEndsAfterRotationGrace(t *testing.T) {
	path := filepath.Join(t.TempDir(), "service.log")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	ticks := make(chan time.Time)
	events, err := followFileEventTicks(ctx, path, ticks, func() {})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		followTestTick(t, ticks)
	}
	event, ok := <-events
	if !ok || !errors.Is(event.err, os.ErrNotExist) || LogDiagnostic(event.err).Reason != "file_missing" {
		t.Fatalf("missing-file event: %+v", event)
	}
	if _, ok := <-events; ok {
		t.Fatal("events after terminal source failure")
	}
}

func TestFileUnreadableSourceReportsPermission(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can read mode-000 files")
	}
	path := filepath.Join(t.TempDir(), "private.log")
	if err := os.WriteFile(path, nil, 0o000); err != nil {
		t.Fatal(err)
	}
	source := NewFile(path, time.Millisecond)
	for _, read := range []func() error{
		func() error { _, err := source.Tail(context.Background(), "telemt", 1); return err },
		func() error { _, err := source.Stream(context.Background(), "telemt"); return err },
	} {
		err := read()
		if err == nil || LogDiagnostic(err).Reason != "permission_denied" {
			t.Fatalf("unreadable source error: %v", err)
		}
	}
}

func TestCommandTailCancellationKeepsTimeoutReason(t *testing.T) {
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	runner := &fakeRunner{err: &ExitError{Code: -1}}
	for _, source := range []LogSource{NewJournald(runner.run, nil), NewDockerLog(runner.run, nil), NewLogread(runner.run, nil)} {
		_, err := source.Tail(ctx, "telemt", 1)
		if err == nil || LogDiagnostic(err).Reason != "source_timeout" {
			t.Fatalf("%s timeout: %v", source.Kind(), err)
		}
	}
}

func TestStructuredServiceLogsDoNotClassifySourceFailure(t *testing.T) {
	line := `{"MESSAGE":"application request failed: permission denied"}`
	if got := commandLogReason(line); got != "" {
		t.Fatalf("application message became source diagnostic %q", got)
	}
}

func TestCommandLogStreamClassifiesOnlyRecentRawLinesAtFailure(t *testing.T) {
	for _, test := range []struct {
		name   string
		raw    string
		err    error
		reason string
	}{
		{"expired permission text", "permission denied\n" + strings.Repeat("service line\n", 8), &ExitError{Code: 7}, "command_failed"},
		{"oldest retained permission text", "permission denied\n" + strings.Repeat("service line\n", 7), &ExitError{Code: 7}, "permission_denied"},
		{"newest matching reason", "permission denied\nNo such container: telemt\nservice line\n", &ExitError{Code: 7}, "target_missing"},
		{"large raw lines still evict old text", "permission denied\n" + strings.Repeat(strings.Repeat("x", 4097)+"\n", 8), &ExitError{Code: 7}, "command_failed"},
		{"large diagnostic is ignored", strings.Repeat("x", 4096) + "permission denied\n", &ExitError{Code: 7}, "command_failed"},
		{"recent scanner failure", "permission denied\n", errors.New("scanner read failure"), "permission_denied"},
		{"normal EOF", "permission denied\n", nil, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			reader, writer := io.Pipe()
			events := streamCommandLogs(ctx, reader, func(raw []byte) (LogLine, bool) {
				return LogLine{Msg: string(raw)}, true
			})
			go func() {
				io.WriteString(writer, test.raw)
				writer.CloseWithError(test.err)
			}()
			var terminal error
			var lines int
			for event := range events {
				if event.Err != nil {
					terminal = event.Err
				} else {
					lines++
				}
			}
			if ctx.Err() != nil {
				t.Fatal("stream did not terminate")
			}
			if lines != strings.Count(test.raw, "\n") {
				t.Fatalf("received %d lines, want %d", lines, strings.Count(test.raw, "\n"))
			}
			if test.reason == "" {
				if terminal != nil {
					t.Fatalf("normal EOF emitted source error: %v", terminal)
				}
				return
			}
			if terminal == nil || LogDiagnostic(terminal).Reason != test.reason {
				t.Fatalf("terminal diagnostic = %v, want reason %q", terminal, test.reason)
			}
		})
	}
}
