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
		var recent [8]string
		next := 0
		for scanner.Scan() {
			recent[next] = ""
			if len(scanner.Bytes()) <= 4096 {
				recent[next] = scanner.Text()
			}
			next = (next + 1) % len(recent)
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
			var reason string
			for i := 1; i <= len(recent); i++ {
				if reason = commandLogReason(recent[(next+len(recent)-i)%len(recent)]); reason != "" {
					break
				}
			}
			select {
			case events <- LogEvent{Err: newLogSourceError(err, reason)}:
			case <-ctx.Done():
			}
		}
	}()
	return events
}
