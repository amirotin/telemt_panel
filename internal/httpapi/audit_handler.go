package httpapi

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/store"
)

// defaultAuditLimit and maxAuditLimit mirror openapi getAudit's `limit`
// parameter (default 100, maximum 500 — matching store.auditCap, the
// ring's own retention bound).
const (
	defaultAuditLimit = 100
	maxAuditLimit     = 500
)

// auditEntryView mirrors api/openapi.yaml AuditEntry.
type auditEntryView struct {
	TS       time.Time         `json:"ts"`
	ID       string            `json:"id"`
	Action   string            `json:"action"`
	Actor    string            `json:"actor,omitempty"`
	Target   string            `json:"target,omitempty"`
	Outcome  string            `json:"outcome"`
	IP       string            `json:"ip,omitempty"`
	Subject  string            `json:"subject,omitempty"`
	Detail   string            `json:"detail,omitempty"`
	Metadata map[string]string `json:"metadata,omitempty"`
}

// handleGetAudit implements GET /api/audit?limit=&before=: the store's
// audit ring, newest first. Cursor: `before` is an entry's own `ts` value
// from a previous response (RFC3339Nano, matching how Go's encoding/json
// marshals time.Time) — passing it back returns entries strictly older
// than that timestamp, letting a client page further into the ring one
// "load more" at a time. There is no explicit sequence number in
// store.AuditEntry; ts is precise enough (nanosecond) that two entries
// racing to the exact same instant is not a practical concern for an
// admin-action log at this volume.
func (s *Server) handleGetAudit(w http.ResponseWriter, r *http.Request) {
	limit := defaultAuditLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			auth.WriteError(w, http.StatusBadRequest, "bad_request", "limit must be a positive integer")
			return
		}
		if n > maxAuditLimit {
			n = maxAuditLimit
		}
		limit = n
	}

	var before time.Time
	if raw := r.URL.Query().Get("before"); raw != "" {
		t, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			auth.WriteError(w, http.StatusBadRequest, "bad_request", "before must be a ts cursor from a prior response")
			return
		}
		before = t
	}

	// ListAudit(0) — no cap, see its doc comment — returns every retained
	// entry (bounded by the ring's own auditCap, at most 500); filtering by
	// `before` and truncating to `limit` happens here rather than adding a
	// cursor-aware Store method, since the whole retained ring is already
	// this small.
	entries, err := s.st.ListAudit(0)
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not read audit log")
		return
	}

	out := make([]auditEntryView, 0, limit)
	for _, e := range entries {
		if !before.IsZero() && !e.TS.Before(before) {
			continue
		}
		out = append(out, s.toAuditEntryView(e))
		if len(out) == limit {
			break
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) toAuditEntryView(e store.AuditEntry) auditEntryView {
	id := e.ID
	if id == "" {
		id = auditEntryID(e.TS)
	}
	actor := e.Actor
	if actor == "" {
		if e.Action == "login" || e.Action == "login.failed" || e.Action == "logout" {
			actor = e.Subject
		} else {
			actor = s.cfg.Auth.Username
		}
	}
	target := e.Target
	if target == "" {
		target = auditTarget(e.Action, e.Subject)
	}
	outcome := e.Outcome
	if outcome == "" {
		outcome = auditOutcome(e.Action)
	}
	ip := e.IP
	if ip == "" && strings.HasPrefix(e.Detail, "ip=") {
		ip = strings.TrimPrefix(e.Detail, "ip=")
	}
	return auditEntryView{
		TS:       e.TS,
		ID:       id,
		Action:   e.Action,
		Actor:    actor,
		Target:   target,
		Outcome:  outcome,
		IP:       ip,
		Subject:  e.Subject,
		Detail:   e.Detail,
		Metadata: auditMetadata(e.Detail),
	}
}

func auditMetadata(detail string) map[string]string {
	metadata := make(map[string]string)
	fields := strings.FieldsFunc(detail, func(r rune) bool {
		return r == ' ' || r == '\t' || r == '\n' || r == ',' || r == '·'
	})
	for _, field := range fields {
		key, value, ok := strings.Cut(field, "=")
		if ok && key != "" && value != "" {
			metadata[key] = value
		}
	}
	if len(metadata) == 0 {
		return nil
	}
	return metadata
}
