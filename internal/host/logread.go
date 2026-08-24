package host

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"strings"
	"time"
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
			case ch <- parseLogreadLine(scanner.Text()):
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

func parseLogreadLines(out []byte) []LogLine {
	var lines []LogLine
	scanner := bufio.NewScanner(bytes.NewReader(out))
	scanner.Buffer(make([]byte, 64*1024), 1<<20)
	for scanner.Scan() {
		text := scanner.Text()
		if text == "" {
			continue
		}
		lines = append(lines, parseLogreadLine(text))
	}
	return lines
}

// ansicWidth is the fixed width of an ANSIC-formatted timestamp ("Mon Jan
// _2 15:04:05 2006", e.g. "Thu Jan  1 00:00:10 1970") — logread's leading
// timestamp field, space-padded day included. Slicing by this fixed width
// rather than splitting on spaces avoids the classic ctime pitfall where a
// single-digit day's extra padding space would otherwise look like an
// empty field.
const ansicWidth = len("Mon Jan _2 15:04:05 2006")

// parseLogreadLine parses OpenWrt logread's syslog-ish line format:
//
//	Thu Jan  1 00:00:10 1970 daemon.info telemt[123]: message text
//
// leniently — any line that doesn't match this shape (or whose timestamp
// doesn't parse) is kept as-is: Level "unknown", the whole line as Msg,
// rather than being dropped. logread's exact output varies across
// OpenWrt/busybox versions, so this never treats a mismatch as an error.
func parseLogreadLine(line string) LogLine {
	if len(line) <= ansicWidth+1 {
		return LogLine{Level: "unknown", Msg: line}
	}
	ts, tsErr := time.Parse(time.ANSIC, line[:ansicWidth])
	rest := strings.TrimPrefix(line[ansicWidth:], " ")

	facilitySeverity, tail, ok := strings.Cut(rest, " ")
	if !ok {
		return LogLine{Level: "unknown", Msg: line}
	}
	level := "unknown"
	if idx := strings.LastIndexByte(facilitySeverity, '.'); idx >= 0 {
		level = severityToLevel(facilitySeverity[idx+1:])
	}

	unit, msg := splitLogreadTag(tail)
	result := LogLine{Level: level, Unit: unit, Msg: msg}
	if tsErr == nil {
		result.TS = ts
	}
	return result
}

// severityToLevel maps a syslog facility.severity's severity word (the
// part after the last '.') to the panel's normalized level.
func severityToLevel(sev string) string {
	switch strings.ToLower(sev) {
	case "emerg", "alert", "crit", "err", "error":
		return "error"
	case "warn", "warning":
		return "warn"
	case "notice", "info":
		return "info"
	case "debug":
		return "debug"
	default:
		return "unknown"
	}
}

// splitLogreadTag splits "tag[pid]: message" (or "tag: message") into the
// unit (tag with any [pid] suffix stripped) and the message. A tail with
// no ": " separator comes back with an empty unit and the whole tail as
// the message.
func splitLogreadTag(tail string) (unit, msg string) {
	idx := strings.Index(tail, ": ")
	if idx < 0 {
		return "", tail
	}
	tag := tail[:idx]
	msg = tail[idx+2:]
	if b := strings.IndexByte(tag, '['); b >= 0 {
		tag = tag[:b]
	}
	return tag, msg
}
