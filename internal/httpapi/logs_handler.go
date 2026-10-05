package httpapi

import (
	"context"
	"encoding/json"
	"errors"
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
func (s *Server) resolveLogStream(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	logical := r.URL.Query().Get("service")
	name, ok := resolveLogicalService(logical, s.logSrc.Kind(), s.cfg.Host)
	if !ok {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", fmt.Sprintf("unknown service %q (want telemt or panel)", logical))
		return "", "", false
	}
	if !s.logSrc.Caps().CanStream {
		auth.WriteError(w, http.StatusNotImplemented, "log_stream_unavailable", noLogSourceHint)
		return "", "", false
	}
	return logical, name, true
}

func writeLogAdmissionError(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrLogStreamLimit) {
		w.Header().Set("Retry-After", "5")
		auth.WriteError(w, http.StatusTooManyRequests, "logs_stream_limit", "too many active log streams")
		return
	}
	auth.WriteError(w, http.StatusServiceUnavailable, "capability_unavailable", "log streams are shutting down")
}

func (s *Server) handleProbeLogStream(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := s.resolveLogStream(w, r); !ok {
		return
	}
	hash, _ := auth.SessionIDHashFromContext(r.Context())
	if err := s.logStreams.capacityError(hash); err != nil {
		writeLogAdmissionError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleEventsLogs(w http.ResponseWriter, r *http.Request) {
	logical, name, ok := s.resolveLogStream(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	stream, release, allowed := s.trackSessionStream(w, r.WithContext(ctx))
	if !allowed {
		return
	}
	defer release()
	ctx = stream.ctx
	hash, _ := auth.SessionIDHashFromContext(r.Context())
	deregister, err := s.logStreams.TryRegister(hash, cancel)
	if err != nil {
		writeLogAdmissionError(w, err)
		return
	}
	defer deregister()

	flusher, ok := w.(http.Flusher)
	if !ok {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "streaming unsupported")
		return
	}
	ch, err := s.logSrc.Stream(ctx, name)
	defer func() {
		cancel()
		if ch == nil {
			return
		}
		// Retain admission until the source has finished stopping. Source
		// channels close after their process/watcher exits on cancellation.
		deadline := time.NewTimer(5 * time.Second)
		defer deadline.Stop()
		for {
			select {
			case _, open := <-ch:
				if !open {
					return
				}
			case <-deadline.C:
				return
			}
		}
	}()
	rc := stream.rc

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	extendSSEWriteDeadline(rc)
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	if err != nil {
		if ctx.Err() == nil {
			if stream.write(func() error { return writeLogSourceErrorEvent(w, s.logSourceDiagnostic(err, logical, name)) }) == nil {
				flusher.Flush()
			}
		}
		return
	}

	heartbeat := time.NewTicker(s.logStreamHeartbeat)
	defer heartbeat.Stop()
	sessionCheck := time.NewTicker(sessionStreamCheckInterval)
	defer sessionCheck.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-sessionCheck.C:
			if stream.check() != nil {
				return
			}
		case line, open := <-ch:
			if !open {
				if ctx.Err() == nil {
					if err := stream.write(func() error { _, err := fmt.Fprint(w, "event: log_end\ndata: {}\n\n"); return err }); err == nil {
						flusher.Flush()
					}
				}
				return
			}
			if line.Err != nil {
				if ctx.Err() == nil && stream.write(func() error { return writeLogSourceErrorEvent(w, s.logSourceDiagnostic(line.Err, logical, name)) }) == nil {
					flusher.Flush()
				}
				return
			}
			if err := stream.write(func() error { return writeLogSSEEvent(w, line.LogLine, logical) }); err != nil {
				return
			}
			flusher.Flush()
		case <-heartbeat.C:
			// Same observable form as handleEvents' heartbeat
			// (sseHeartbeatFrame, sse.go) — the two SSE endpoints must stay
			// consistent.
			if err := stream.write(func() error { _, err := fmt.Fprint(w, sseHeartbeatFrame); return err }); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
