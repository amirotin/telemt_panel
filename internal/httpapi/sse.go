package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/hub"
)

// snapshotFetchTimeout bounds an on-demand fetch for an idle topic in
// handleSnapshot.
const snapshotFetchTimeout = 10 * time.Second

// sseWriteDeadline is how far forward handleEvents pushes the connection's
// write deadline before every SSE write. http.Server.WriteTimeout
// (server.go) is armed once, as an absolute deadline for the whole
// response — it does not reset itself just because the handler keeps
// writing. An SSE stream is technically "still writing" for as long as the
// client stays connected, so left alone that deadline would kill every
// stream at the WriteTimeout mark regardless of heartbeats. Extending the
// deadline via http.ResponseController on each write keeps normal
// (non-streaming) routes protected by the same WriteTimeout while letting
// a healthy stream live indefinitely.
const sseWriteDeadline = 60 * time.Second

// extendSSEWriteDeadline pushes w's write deadline sseWriteDeadline into
// the future; see sseWriteDeadline's doc comment. SetWriteDeadline can
// fail on a transport that doesn't support deadlines (not the case for
// net/http's own connections) — that error is ignored here and would
// surface on the next actual write instead.
func extendSSEWriteDeadline(rc *http.ResponseController) {
	_ = rc.SetWriteDeadline(time.Now().Add(sseWriteDeadline))
}

// parseTopics splits a comma-separated topics query param into a
// deduplicated, non-empty list. /api/events and /api/snapshot both require
// at least one topic.
func parseTopics(raw string) ([]string, error) {
	parts := strings.Split(raw, ",")
	seen := make(map[string]struct{}, len(parts))
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if _, dup := seen[p]; dup {
			continue
		}
		seen[p] = struct{}{}
		out = append(out, p)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("topics parameter is required")
	}
	return out, nil
}

// writeUnknownTopicOr500 writes 400 bad_request naming the topic for
// *hub.ErrUnknownTopic, otherwise 500 internal_error.
func writeUnknownTopicOr500(w http.ResponseWriter, err error, action string) {
	var unknown *hub.ErrUnknownTopic
	if errors.As(err, &unknown) {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	auth.WriteError(w, http.StatusInternalServerError, "internal_error", action+" failed")
}

// handleSnapshot implements GET /api/snapshot?topics=a,b: the current
// cached payload for each requested topic, fetching on demand for any
// topic the hub isn't actively polling.
func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	topics, err := parseTopics(r.URL.Query().Get("topics"))
	if err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), snapshotFetchTimeout)
	defer cancel()

	snap, err := s.hub.Snapshot(ctx, topics)
	if err != nil {
		writeUnknownTopicOr500(w, err, "snapshot")
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

// sseEventPayload is the data field of a topic snapshot/update event.
type sseEventPayload struct {
	V  json.RawMessage `json:"v"`
	TS int64           `json:"ts"`
}

// sseErrorPayload is the data field of a source_error event.
type sseErrorPayload struct {
	Topic string `json:"topic"`
	Code  string `json:"code"`
}

// writeSSEEvent renders one hub.Event as an SSE frame: `id`/`event`/`data`
// lines followed by a blank line. See v2/specs/02-hub-sse.md.
func writeSSEEvent(w io.Writer, e hub.Event) error {
	if e.Err != "" {
		payload, err := json.Marshal(sseErrorPayload{Topic: e.Topic, Code: e.Err})
		if err != nil {
			return err
		}
		_, err = fmt.Fprintf(w, "id: %d\nevent: source_error\ndata: %s\n\n", e.Seq, payload)
		return err
	}

	payload, err := json.Marshal(sseEventPayload{V: e.Data, TS: e.TS})
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", e.Seq, e.Topic, payload)
	return err
}

// handleEvents implements GET /api/events?topics=a,b: a Server-Sent Events
// stream of hub broadcasts for the requested topics. On connect it writes
// each topic's current snapshot immediately (or, with a Last-Event-ID that
// is still in the hub's replay ring, just the events missed since then);
// after that, events stream as the hub broadcasts them, with a heartbeat
// comment during quiet periods to keep intermediary proxies from timing
// the connection out.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	topics, err := parseTopics(r.URL.Query().Get("topics"))
	if err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}

	ch, snapshots, cancel, err := s.hub.Subscribe(topics)
	if err != nil {
		writeUnknownTopicOr500(w, err, "subscribe")
		return
	}
	defer cancel()

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

	replayed := false
	if lastID := r.Header.Get("Last-Event-ID"); lastID != "" {
		if since, err := strconv.ParseUint(lastID, 10, 64); err == nil {
			if events, ok := s.hub.ReplaySince(since, topics); ok {
				for _, e := range events {
					extendSSEWriteDeadline(rc)
					if err := writeSSEEvent(w, e); err != nil {
						return
					}
				}
				replayed = true
			}
		}
	}
	if !replayed {
		for _, e := range snapshots {
			extendSSEWriteDeadline(rc)
			if err := writeSSEEvent(w, e); err != nil {
				return
			}
		}
	}
	flusher.Flush()

	heartbeat := time.NewTicker(s.hub.HeartbeatInterval())
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case e, open := <-ch:
			if !open {
				return
			}
			extendSSEWriteDeadline(rc)
			if err := writeSSEEvent(w, e); err != nil {
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
