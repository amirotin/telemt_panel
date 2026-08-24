package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/host"
)

// defaultTailLines and maxTailLines mirror openapi tailLogs' `lines`
// parameter (default 200, maximum 1000).
const (
	defaultTailLines = 200
	maxTailLines     = 1000
)

// logTailTimeout bounds one Tail call (a real command execution, unlike
// the in-memory hub reads elsewhere in this package).
const logTailTimeout = 10 * time.Second

// logStreamHeartbeatInterval matches the brief's 25s heartbeat for
// GET /api/events/logs (separate from the hub's configurable heartbeat,
// since log streaming doesn't go through the hub).
const logStreamHeartbeatInterval = 25 * time.Second

// apiLogLine is the wire shape of openapi LogLine.
type apiLogLine struct {
	TS    time.Time `json:"ts"`
	Level string    `json:"level,omitempty"`
	Unit  string    `json:"unit,omitempty"`
	Msg   string    `json:"msg"`
}

func toAPILogLine(l host.LogLine) apiLogLine {
	return apiLogLine{TS: l.TS, Level: l.Level, Unit: l.Unit, Msg: l.Msg}
}

func toAPILogLines(in []host.LogLine) []apiLogLine {
	out := make([]apiLogLine, len(in))
	for i, l := range in {
		out[i] = toAPILogLine(l)
	}
	return out
}

// handleLogsTail implements GET /api/logs/tail?service=telemt|panel&lines=.
func (s *Server) handleLogsTail(w http.ResponseWriter, r *http.Request) {
	logical := r.URL.Query().Get("service")
	name, ok := resolveLogicalService(logical, s.logSrc.Kind(), s.cfg.Host)
	if !ok {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", fmt.Sprintf("unknown service %q (want telemt or panel)", logical))
		return
	}
	if !s.logSrc.Caps().CanTail {
		auth.WriteError(w, http.StatusNotImplemented, "log_tail_unavailable", noLogSourceHint)
		return
	}

	lines := defaultTailLines
	if raw := r.URL.Query().Get("lines"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			auth.WriteError(w, http.StatusBadRequest, "bad_request", "lines must be a positive integer")
			return
		}
		lines = n
	}
	if lines > maxTailLines {
		lines = maxTailLines
	}

	ctx, cancel := context.WithTimeout(r.Context(), logTailTimeout)
	defer cancel()
	result, err := s.logSrc.Tail(ctx, name, lines)
	if err != nil {
		auth.WriteError(w, http.StatusBadGateway, "log_source_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, toAPILogLines(result))
}

// writeLogSSEEvent renders one host.LogLine as an SSE frame: `event: log`
// + JSON data, matching openapi streamLogs.
func writeLogSSEEvent(w io.Writer, l host.LogLine) error {
	payload, err := json.Marshal(toAPILogLine(l))
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "event: log\ndata: %s\n\n", payload)
	return err
}

// handleEventsLogs implements GET /api/events/logs?service=telemt|panel: a
// Server-Sent Events stream of a service's log lines. It reuses the SSE
// write-deadline pattern from sse.go (extendSSEWriteDeadline) rather than
// duplicating it, and registers its cancel func with the server's
// logStreamRegistry so a server shutdown ends it immediately instead of
// stalling http.Server.Shutdown on an open client (see server.go's Run and
// sse.go's handleEvents for the equivalent /api/events case).
func (s *Server) handleEventsLogs(w http.ResponseWriter, r *http.Request) {
	logical := r.URL.Query().Get("service")
	name, ok := resolveLogicalService(logical, s.logSrc.Kind(), s.cfg.Host)
	if !ok {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", fmt.Sprintf("unknown service %q (want telemt or panel)", logical))
		return
	}
	if !s.logSrc.Caps().CanStream {
		auth.WriteError(w, http.StatusNotImplemented, "log_stream_unavailable", noLogSourceHint)
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	deregister := s.logStreams.register(cancel)
	defer deregister()

	ch, err := s.logSrc.Stream(ctx, name)
	if err != nil {
		auth.WriteError(w, http.StatusBadGateway, "log_source_error", err.Error())
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "streaming unsupported")
		return
	}
	rc := http.NewResponseController(w)

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	extendSSEWriteDeadline(rc)
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	heartbeat := time.NewTicker(logStreamHeartbeatInterval)
	defer heartbeat.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case line, open := <-ch:
			if !open {
				return
			}
			extendSSEWriteDeadline(rc)
			if err := writeLogSSEEvent(w, line); err != nil {
				return
			}
			flusher.Flush()
		case <-heartbeat.C:
			extendSSEWriteDeadline(rc)
			if _, err := fmt.Fprint(w, ": hb\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
