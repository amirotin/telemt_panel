package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
	"unicode/utf8"

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
// since log streaming doesn't go through the hub) — Server.logStreamHeartbeat
// defaults to this and tests override the field directly for determinism.
const logStreamHeartbeatInterval = 25 * time.Second

// apiLogLine is the wire shape of openapi LogLine.
type apiLogLine struct {
	TS    time.Time `json:"ts"`
	Level string    `json:"level,omitempty"`
	Unit  string    `json:"unit,omitempty"`
	Msg   string    `json:"msg"`
}

type apiLogSourceDiagnostic struct {
	Code     string `json:"code"`
	Message  string `json:"message"`
	Source   string `json:"source"`
	Service  string `json:"service"`
	Target   string `json:"target,omitempty"`
	Reason   string `json:"reason"`
	ExitCode *int   `json:"exit_code,omitempty"`
}

func (s *Server) logSourceDiagnostic(err error, logical, name string) apiLogSourceDiagnostic {
	diagnostic := host.LogDiagnostic(err)
	if s.logSrc.Kind() == host.LogKindFile {
		name = s.cfg.Host.LogFile
	}
	name = stripLogControls(name)
	if utf8.RuneCountInString(name) > 256 {
		name = string([]rune(name)[:256])
	}
	return apiLogSourceDiagnostic{Code: "log_source_error", Message: diagnostic.Error(), Source: s.logSrc.Kind(), Service: logical, Target: name, Reason: diagnostic.Reason, ExitCode: diagnostic.ExitCode}
}

func writeLogSourceErrorEvent(w io.Writer, diagnostic apiLogSourceDiagnostic) error {
	payload, err := json.Marshal(diagnostic)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "event: log_source_error\ndata: %s\n\n", payload)
	return err
}

func toAPILogLine(l host.LogLine, logical string) apiLogLine {
	l.Msg = stripLogControls(l.Msg)
	if logical == "telemt" {
		if ts, level, ok := telemtLogPrefix(l.Msg); ok {
			l.Level = level
			if l.TS.IsZero() {
				l.TS = ts
			}
		}
	}
	return apiLogLine{TS: l.TS, Level: l.Level, Unit: l.Unit, Msg: l.Msg}
}

func toAPILogLines(in []host.LogLine, logical string) []apiLogLine {
	out := make([]apiLogLine, len(in))
	for i, l := range in {
		out[i] = toAPILogLine(l, logical)
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
		writeJSON(w, http.StatusBadGateway, s.logSourceDiagnostic(err, logical, name))
		return
	}
	writeJSON(w, http.StatusOK, toAPILogLines(result, logical))
}

// writeLogSSEEvent renders one host.LogLine as an SSE frame: `event: log`
// + JSON data, matching openapi streamLogs.
func writeLogSSEEvent(w io.Writer, l host.LogLine, logical string) error {
	payload, err := json.Marshal(toAPILogLine(l, logical))
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
	if err != nil {
		if ctx.Err() == nil {
			extendSSEWriteDeadline(rc)
			if writeLogSourceErrorEvent(w, s.logSourceDiagnostic(err, logical, name)) == nil {
				flusher.Flush()
			}
		}
		return
	}

	heartbeat := time.NewTicker(s.logStreamHeartbeat)
	defer heartbeat.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case line, open := <-ch:
			if !open {
				if ctx.Err() == nil {
					extendSSEWriteDeadline(rc)
					if _, err := fmt.Fprint(w, "event: log_end\ndata: {}\n\n"); err == nil {
						flusher.Flush()
					}
				}
				return
			}
			extendSSEWriteDeadline(rc)
			if line.Err != nil {
				if ctx.Err() == nil && writeLogSourceErrorEvent(w, s.logSourceDiagnostic(line.Err, logical, name)) == nil {
					flusher.Flush()
				}
				return
			}
			if err := writeLogSSEEvent(w, line.LogLine, logical); err != nil {
				return
			}
			flusher.Flush()
		case <-heartbeat.C:
			extendSSEWriteDeadline(rc)
			// Same observable form as handleEvents' heartbeat
			// (sseHeartbeatFrame, sse.go) — the two SSE endpoints must stay
			// consistent.
			if _, err := fmt.Fprint(w, sseHeartbeatFrame); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
