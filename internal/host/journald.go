package host

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Journald reads Telemt/panel logs via journalctl on systemd hosts. Tail
// runs `journalctl -u <svc> -n <N> --no-pager -o json` to completion via
// CmdRunner; Stream runs `journalctl -u <svc> -f -o json`, a long-lived
// process that never exits on its own, via the injectable ProcessStarter.
type Journald struct {
	run   CmdRunner
	start ProcessStarter
}

// NewJournald builds a Journald LogSource that runs journalctl through
// runner (Tail) and starter (Stream).
func NewJournald(runner CmdRunner, starter ProcessStarter) *Journald {
	return &Journald{run: runner, start: starter}
}

// Kind implements LogSource.
func (j *Journald) Kind() string { return LogKindJournald }

// Tail implements LogSource.
func (j *Journald) Tail(ctx context.Context, service string, lines int) ([]LogLine, error) {
	out, stderr, err := j.run(ctx, "journalctl", "-u", service, "-n", strconv.Itoa(lines), "--no-pager", "-o", "json")
	if err != nil {
		return nil, fmt.Errorf("journalctl -u %s: %s: %w", service, strings.TrimSpace(string(stderr)), err)
	}
	return parseJournaldLines(out), nil
}

// Stream implements LogSource.
func (j *Journald) Stream(ctx context.Context, service string) (<-chan LogLine, error) {
	rc, err := j.start(ctx, "journalctl", "-u", service, "-f", "-o", "json")
	if err != nil {
		return nil, fmt.Errorf("journalctl -u %s -f: %w", service, err)
	}
	ch := make(chan LogLine)
	go func() {
		defer close(ch)
		defer rc.Close()
		scanner := bufio.NewScanner(rc)
		scanner.Buffer(make([]byte, 64*1024), 1<<20)
		for scanner.Scan() {
			line, ok := parseJournaldLine(scanner.Bytes())
			if !ok {
				continue
			}
			select {
			case ch <- line:
			case <-ctx.Done():
				return
			}
		}
	}()
	return ch, nil
}

// Caps implements LogSource.
func (j *Journald) Caps() LogCaps {
	return LogCaps{CanTail: true, CanStream: true}
}

// parseJournaldLines parses `journalctl -o json` output: one JSON object
// per line, not a JSON array. A line that isn't valid JSON is skipped
// rather than failing the whole tail — journalctl occasionally interleaves
// plain-text notices on stdout (e.g. "-- No entries --" for an empty unit).
func parseJournaldLines(out []byte) []LogLine {
	var lines []LogLine
	scanner := bufio.NewScanner(bytes.NewReader(out))
	scanner.Buffer(make([]byte, 64*1024), 1<<20)
	for scanner.Scan() {
		line, ok := parseJournaldLine(scanner.Bytes())
		if ok {
			lines = append(lines, line)
		}
	}
	return lines
}

// journaldEntry maps the fields Tail/Stream need out of one `-o json`
// object. PRIORITY and MESSAGE are kept raw because journald encodes a
// field as a JSON array of byte values instead of a string whenever its
// content isn't valid UTF-8 — both need lenient decoding, not a fixed type.
type journaldEntry struct {
	RealtimeTimestamp string          `json:"__REALTIME_TIMESTAMP"`
	Priority          json.RawMessage `json:"PRIORITY"`
	Message           json.RawMessage `json:"MESSAGE"`
	Unit              string          `json:"_SYSTEMD_UNIT"`
}

// parseJournaldLine parses one `-o json` line. ok is false only when the
// line isn't valid JSON at all; a recognized-but-odd entry (missing or
// out-of-range PRIORITY, non-UTF8 MESSAGE, unparseable timestamp) still
// comes back ok with the affected field defaulted (Level "unknown", Msg
// "", TS zero) rather than being dropped.
func parseJournaldLine(raw []byte) (LogLine, bool) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return LogLine{}, false
	}
	var entry journaldEntry
	if err := json.Unmarshal(raw, &entry); err != nil {
		return LogLine{}, false
	}
	line := LogLine{
		Level: journaldLevel(entry.Priority),
		Unit:  entry.Unit,
		Msg:   journaldStringField(entry.Message),
	}
	if us, err := strconv.ParseInt(entry.RealtimeTimestamp, 10, 64); err == nil {
		line.TS = time.UnixMicro(us)
	}
	return line, true
}

// journaldStringField decodes a journald JSON field that is normally a
// plain string but, for content that isn't valid UTF-8, journalctl emits
// as a JSON array of byte values instead.
func journaldStringField(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var bs []int
	if err := json.Unmarshal(raw, &bs); err == nil {
		b := make([]byte, len(bs))
		for i, n := range bs {
			b[i] = byte(n)
		}
		return string(b)
	}
	return ""
}

// journaldLevel maps PRIORITY (syslog severity 0-7, normally a JSON string
// of digits but decoded leniently either way) to the panel's normalized
// level: 0-3 (emerg..err) = error, 4 (warning) = warn, 5-6 (notice/info) =
// info, 7 (debug) = debug. Missing, null, empty, non-numeric or
// out-of-range values all map to "unknown" rather than guessing.
func journaldLevel(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return "unknown"
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return levelFromPriorityString(s)
	}
	var n int
	if err := json.Unmarshal(raw, &n); err == nil {
		return levelFromPriority(n)
	}
	return "unknown"
}

func levelFromPriorityString(s string) string {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return "unknown"
	}
	return levelFromPriority(n)
}

func levelFromPriority(n int) string {
	switch {
	case n >= 0 && n <= 3:
		return "error"
	case n == 4:
		return "warn"
	case n == 5 || n == 6:
		return "info"
	case n == 7:
		return "debug"
	default:
		return "unknown"
	}
}
