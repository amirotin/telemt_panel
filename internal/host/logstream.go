package host

import (
	"bufio"
	"context"
	"io"
)

func streamCommandLogs(ctx context.Context, reader io.ReadCloser, parse func([]byte) (LogLine, bool)) <-chan LogEvent {
	events := make(chan LogEvent)
	go func() {
		defer close(events)
		defer reader.Close()
		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 64*1024), 1<<20)
		var reason string
		for scanner.Scan() {
			if candidate := commandLogReason(scanner.Text()); candidate != "" {
				reason = candidate
			}
			line, ok := parse(scanner.Bytes())
			if !ok {
				continue
			}
			select {
			case events <- LogEvent{LogLine: line}:
			case <-ctx.Done():
				return
			}
		}
		if err := scanner.Err(); err != nil && ctx.Err() == nil {
			select {
			case events <- LogEvent{Err: newLogSourceError(err, reason)}:
			case <-ctx.Done():
			}
		}
	}()
	return events
}
