package host

import (
	"context"
	"time"
)

// DefaultLogPollInterval is the production poll interval File and Syslog
// use to detect growth when the panel wires them up. Tests inject a much
// smaller interval instead of waiting on this one.
const DefaultLogPollInterval = 2 * time.Second

// File tails an arbitrary log file (host.log_file) when log_source=file.
// It applies no service-name filtering: the operator pointed this source
// at exactly one service's log file already, so every line belongs to the
// requested service by construction.
type File struct {
	path         string
	pollInterval time.Duration
}

// NewFile builds a File LogSource over path, polling for growth every
// pollInterval when streaming.
func NewFile(path string, pollInterval time.Duration) *File {
	return &File{path: path, pollInterval: pollInterval}
}

// Kind implements LogSource.
func (f *File) Kind() string { return LogKindFile }

// Tail implements LogSource.
func (f *File) Tail(ctx context.Context, service string, lines int) ([]LogLine, error) {
	raw, err := tailFileLines(f.path, lines)
	if err != nil {
		return nil, err
	}
	return linesToLogLines(raw, service), nil
}

// Stream implements LogSource.
func (f *File) Stream(ctx context.Context, service string) (<-chan LogLine, error) {
	raw := followFile(ctx, f.path, f.pollInterval)
	ch := make(chan LogLine)
	go func() {
		defer close(ch)
		for line := range raw {
			select {
			case ch <- newLogLine(line, service):
			case <-ctx.Done():
				return
			}
		}
	}()
	return ch, nil
}

// Caps implements LogSource. File is only ever constructed with a
// non-empty, config-validated path (see NewLogSource), so it always
// reports both operations as available; a read failure at call time
// (missing/unreadable file) surfaces as a Tail/Stream error instead.
func (f *File) Caps() LogCaps {
	return LogCaps{CanTail: true, CanStream: true}
}
