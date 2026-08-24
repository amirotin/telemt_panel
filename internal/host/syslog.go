package host

import (
	"context"
	"strings"
	"time"
)

// syslogCandidateLines bounds how many raw lines Tail reads from the
// shared syslog file before filtering by service tag and trimming to the
// requested count. It's deliberately large: tailFileLines' own
// maxTailBytes window is what actually bounds the work, this just needs to
// be large enough that the byte window (not this count) is always the
// binding constraint.
const syslogCandidateLines = 100000

// Syslog tails a shared syslog file (/var/log/messages or /var/log/syslog)
// filtered to lines mentioning the requested service. openrc and sysvinit
// hosts have no per-unit journal — every service's output lands in the one
// file (01-host-matrix.md's "syslog-файл с фильтром по тегу") — so both
// Tail and Stream keep only lines whose text contains the service name.
type Syslog struct {
	path         string
	pollInterval time.Duration
}

// NewSyslog builds a Syslog LogSource over path, polling for growth every
// pollInterval when streaming.
func NewSyslog(path string, pollInterval time.Duration) *Syslog {
	return &Syslog{path: path, pollInterval: pollInterval}
}

// Kind implements LogSource.
func (s *Syslog) Kind() string { return LogKindSyslog }

// Tail implements LogSource. Each matched raw line is parsed via the
// shared parseSyslogishLine (syslogline.go) rather than shipped as a raw
// string — host.go's LogLine doc comment is explicit that the frontend
// never parses raw log text, so this source doesn't get an exception just
// because it reads a plain file instead of a structured API.
func (s *Syslog) Tail(ctx context.Context, service string, lines int) ([]LogLine, error) {
	raw, err := tailFileLines(s.path, syslogCandidateLines)
	if err != nil {
		return nil, err
	}
	matched := filterByTag(raw, service)
	if lines >= 0 && len(matched) > lines {
		matched = matched[len(matched)-lines:]
	}
	out := make([]LogLine, len(matched))
	for i, line := range matched {
		out[i] = parseSyslogishLine(line)
	}
	return out, nil
}

// Stream implements LogSource. See Tail's doc comment on why each line is
// parsed rather than passed through raw.
func (s *Syslog) Stream(ctx context.Context, service string) (<-chan LogLine, error) {
	raw := followFile(ctx, s.path, s.pollInterval)
	ch := make(chan LogLine)
	go func() {
		defer close(ch)
		for line := range raw {
			if service != "" && !strings.Contains(strings.ToLower(line), strings.ToLower(service)) {
				continue
			}
			select {
			case ch <- parseSyslogishLine(line):
			case <-ctx.Done():
				return
			}
		}
	}()
	return ch, nil
}

// Caps implements LogSource. Syslog is only ever constructed with a path
// that existed at detection time (see NewLogSource), so it always reports
// both operations as available; the file disappearing afterward surfaces
// as a Tail/Stream error instead.
func (s *Syslog) Caps() LogCaps {
	return LogCaps{CanTail: true, CanStream: true}
}

// filterByTag keeps only the lines whose text contains service
// (case-insensitive substring match on the syslog tag/message, tolerant of
// the "tag[pid]:" formatting variance across syslog implementations). An
// empty service matches everything.
func filterByTag(lines []string, service string) []string {
	if service == "" {
		return lines
	}
	needle := strings.ToLower(service)
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		if strings.Contains(strings.ToLower(l), needle) {
			out = append(out, l)
		}
	}
	return out
}
