package httpapi

import (
	"net/http"
	"strconv"
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
	TS      time.Time `json:"ts"`
	Action  string    `json:"action"`
	Subject string    `json:"subject,omitempty"`
	Detail  string    `json:"detail,omitempty"`
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
		out = append(out, toAuditEntryView(e))
		if len(out) == limit {
			break
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func toAuditEntryView(e store.AuditEntry) auditEntryView {
	return auditEntryView{TS: e.TS, Action: e.Action, Subject: e.Subject, Detail: e.Detail}
}
