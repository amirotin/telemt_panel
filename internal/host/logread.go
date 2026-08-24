package host

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"strings"
)

// Logread reads Telemt/panel logs via OpenWrt's logread on procd hosts.
// Tail filters by service via `logread -e <svc>`; Stream has no live
// filter (`logread -f` returns every service's output, matching logread's
// own limitations) so the caller sees other services' lines interleaved.
type Logread struct {
	run   CmdRunner
	start ProcessStarter
}

// NewLogread builds a Logread LogSource that runs logread through runner
// (Tail) and starter (Stream).
func NewLogread(runner CmdRunner, starter ProcessStarter) *Logread {
	return &Logread{run: runner, start: starter}
}

// Kind implements LogSource.
func (l *Logread) Kind() string { return LogKindLogread }

// Tail implements LogSource. logread -e has no line-count flag, so the
// full matched output is parsed and trimmed to the requested count here.
func (l *Logread) Tail(ctx context.Context, service string, lines int) ([]LogLine, error) {
	out, stderr, err := l.run(ctx, "logread", "-e", service)
	if err != nil {
		return nil, fmt.Errorf("logread -e %s: %s: %w", service, strings.TrimSpace(string(stderr)), err)
	}
	all := parseLogreadLines(out)
	if lines >= 0 && len(all) > lines {
		all = all[len(all)-lines:]
	}
	return all, nil
}

// Stream implements LogSource.
func (l *Logread) Stream(ctx context.Context, service string) (<-chan LogLine, error) {
	rc, err := l.start(ctx, "logread", "-f")
	if err != nil {
		return nil, fmt.Errorf("logread -f: %w", err)
	}
	ch := make(chan LogLine)
	go func() {
		defer close(ch)
		defer rc.Close()
		scanner := bufio.NewScanner(rc)
		scanner.Buffer(make([]byte, 64*1024), 1<<20)
		for scanner.Scan() {
			select {
			case ch <- parseSyslogishLine(scanner.Text()):
			case <-ctx.Done():
				return
			}
		}
	}()
	return ch, nil
}

// Caps implements LogSource.
func (l *Logread) Caps() LogCaps {
	return LogCaps{CanTail: true, CanStream: true}
}

// parseLogreadLines parses each line of logread -e's output via the shared
// parseSyslogishLine (see syslogline.go).
func parseLogreadLines(out []byte) []LogLine {
	var lines []LogLine
	scanner := bufio.NewScanner(bytes.NewReader(out))
	scanner.Buffer(make([]byte, 64*1024), 1<<20)
	for scanner.Scan() {
		text := scanner.Text()
		if text == "" {
			continue
		}
		lines = append(lines, parseSyslogishLine(text))
	}
	return lines
}
