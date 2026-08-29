package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

// The WEB runtime passthroughs (Telemt >= 3.5.3, `/v1/runtime/web/*`).
//
// Only the READ routes plus the one bounded mutation the panel owns are
// exposed. `POST /v1/runtime/web/debug/clear` and
// `POST /v1/runtime/web/carrier-learning/reset` are deliberately absent:
// they are request-capture and carrier-learning controls, which is Panvex's
// half of the boundary (v2/plans/2026-08-26-m4-details.md, Task 8b) — an
// operator who needs them has `/web-status` on the Telemt API itself.
//
// The status snapshot is NOT here either: it is polled by the hub as the
// "web" topic, so every open browser shares one poll instead of each
// fetching its own.

// webSessionQueryFields is the exact query whitelist Telemt's
// api/web_runtime/request.rs::parse_session_query accepts. The panel
// validates against the same list BEFORE forwarding rather than letting
// Telemt reject it, for two reasons: the browser gets the panel's own
// bad_request envelope instead of a passthrough of Telemt's, and a typo in
// a hand-edited URL cannot become a silently ignored filter if a future
// Telemt ever loosens its own parser.
var webSessionQueryFields = map[string]struct{}{
	"limit": {}, "cursor": {}, "session_ref": {}, "ip": {}, "host": {},
	"user": {}, "user_agent_id": {}, "key_id": {}, "carrier": {}, "state": {},
}

// parseWebSessionsQuery validates the request's query against the whitelist
// and builds the SDK query. Duplicates are rejected the way Telemt rejects
// them: a repeated filter has no defined meaning, and picking one silently
// would show a page that does not match the URL that produced it.
func parseWebSessionsQuery(r *http.Request) (telemt.WebSessionsQuery, error) {
	var out telemt.WebSessionsQuery
	for name, values := range r.URL.Query() {
		if _, ok := webSessionQueryFields[name]; !ok {
			return out, fmt.Errorf("unknown query field %q", name)
		}
		if len(values) > 1 {
			return out, fmt.Errorf("query field %q must not repeat", name)
		}
	}
	query := r.URL.Query()
	if raw := query.Get("limit"); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > telemt.WebSessionsMaxLimit {
			return out, fmt.Errorf("limit must be an integer between 1 and %d", telemt.WebSessionsMaxLimit)
		}
		out.Limit = limit
	}
	out.Cursor = query.Get("cursor")
	out.SessionRef = query.Get("session_ref")
	out.IP = query.Get("ip")
	out.Host = query.Get("host")
	out.User = query.Get("user")
	out.UserAgentID = query.Get("user_agent_id")
	out.KeyID = query.Get("key_id")
	out.Carrier = query.Get("carrier")
	out.State = query.Get("state")
	return out, nil
}

// writeWebTelemtError maps a WEB-group failure onto the panel's envelope.
//
// It exists because the generic writeTelemtError collapses every 5xx into
// 502 telemt_unreachable, and the WEB group's two 503s are not "Telemt is
// unreachable" at all — they are states the UI has a rendering for:
//
//   - web_runtime_unavailable is a CLOSED CAPABILITY. Reported as 503
//     capability_unavailable, the same code /api/telemt/config and
//     /api/telemt/tls-fingerprints already use, so the frontend draws its
//     Gated hint («включите [web]») instead of an error toast. Telemt's own
//     message carries the lifecycle token and is forwarded as the reason.
//   - web_snapshot_busy is a MOMENTARY lock contention on an exact lookup;
//     it keeps its own code and 503 so the page can say "try again" rather
//     than claim the proxy is down.
//
// Everything else falls through to writeTelemtError with capabilityGated
// on, which turns a bare 404/405 (a build predating the WEB routes) into
// 501 capability_absent — R5's `unsupported`, distinct from `disabled`.
// A well-formed web_session_not_found/web_operation_not_found is answered
// here rather than there, for the same reason: that branch reads ANY 404 as
// a missing route.
func writeWebTelemtError(w http.ResponseWriter, err error) {
	var apiErr *telemt.APIError
	if errors.As(err, &apiErr) {
		switch apiErr.Code {
		case telemt.CodeWebRuntimeUnavailable:
			message := "telemt WEB runtime is not running"
			if apiErr.Message != "" {
				message = apiErr.Message
			}
			auth.WriteError(w, http.StatusServiceUnavailable, "capability_unavailable", message)
			return
		case telemt.CodeWebSnapshotBusy:
			auth.WriteError(w, http.StatusServiceUnavailable, telemt.CodeWebSnapshotBusy, apiErr.Message)
			return
		case telemt.CodeWebSessionNotFound, telemt.CodeWebOperationNotFound:
			// A well-formed 404 for a ref/id that simply is not there. It
			// must NOT reach writeTelemtError's capabilityGated branch,
			// which reads any 404 as "the route is absent" and would tell
			// the operator to update Telemt because one session ended.
			auth.WriteError(w, http.StatusNotFound, apiErr.Code, apiErr.Message)
			return
		}
	}
	writeTelemtError(w, err, true)
}

// handleGetTelemtWebSessions implements GET /api/telemt/web/sessions: a
// filtered, cursor-paged passthrough of Telemt's own listing. Fetch-on-visit
// rather than a topic field for the same reason TLS fingerprints are — a
// page of 50 sessions has no business being re-polled for every connected
// client, and the filters are per-reader state.
func (s *Server) handleGetTelemtWebSessions(w http.ResponseWriter, r *http.Request) {
	query, err := parseWebSessionsQuery(r)
	if err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), telemtConfigRequestTimeout)
	defer cancel()

	page, err := s.tc.WebSessions(ctx, query)
	if err != nil {
		writeWebTelemtError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

// handleGetTelemtWebSession implements GET /api/telemt/web/sessions/{ref}.
// The response is the SDK's three-way result: `row` for a live session,
// `closed` for a retained tombstone (Telemt's HTTP 410 inside a success
// envelope), and an error envelope for 404/503. Both outcomes are reported
// as 200 with the discriminating field set, so the browser's fetch layer
// does not have to treat "this session just closed" as a failure.
func (s *Server) handleGetTelemtWebSession(w http.ResponseWriter, r *http.Request) {
	ref := r.PathValue("ref")
	if ref == "" {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "session ref is required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), telemtConfigRequestTimeout)
	defer cancel()

	result, err := s.tc.WebSession(ctx, ref)
	if err != nil {
		writeWebTelemtError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// handleGetTelemtWebOperation implements GET
// /api/telemt/web/operations/{id} — the poll half of the close action.
func (s *Server) handleGetTelemtWebOperation(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "operation id is required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), telemtConfigRequestTimeout)
	defer cancel()

	op, err := s.tc.WebOperation(ctx, id)
	if err != nil {
		writeWebTelemtError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, op)
}

// handlePostTelemtWebSessionsClose implements POST
// /api/telemt/web/sessions/close — the one WEB mutation the panel owns.
//
// Everything about it is deliberately narrow. The body is decoded into the
// SDK's own request type and re-encoded, so a field Telemt does not know
// cannot be smuggled through a blind proxy into a `deny_unknown_fields`
// decoder. `runtime_instance` is mandatory and is the process fence: a
// close built against a status snapshot from a Telemt that has since
// restarted is refused with 409 web_runtime_mismatch rather than applied to
// whatever now holds those ids. Telemt's own read_only mode surfaces as 403
// through writeTelemtError, so a read-only proxy cannot be mutated from
// here either.
func (s *Server) handlePostTelemtWebSessionsClose(w http.ResponseWriter, r *http.Request) {
	var req telemt.WebCloseRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxWebCloseBodyBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "invalid close request body")
		return
	}
	if req.RuntimeInstance == "" {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "runtime_instance is required")
		return
	}
	switch req.Selector.Kind {
	case telemt.WebCloseSelectorRefs, telemt.WebCloseSelectorFilter, telemt.WebCloseSelectorAll:
	default:
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "selector.kind must be refs, filter or all")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), telemtConfigRequestTimeout)
	defer cancel()

	op, err := s.tc.WebSessionsClose(ctx, req)
	if err != nil {
		writeWebTelemtError(w, err)
		return
	}

	s.appendAudit("web.sessions.close", req.Selector.Kind, webCloseAuditDetail(req.Selector, op))
	writeJSON(w, http.StatusAccepted, op)
}

// maxWebCloseBodyBytes bounds the close request body. The largest legal one
// is 200 canonical refs (~72 bytes each) plus the fence — 64 KiB is Telemt's
// own cap for this route and leaves an order of magnitude of headroom.
const maxWebCloseBodyBytes = 64 << 10

// webCloseAuditDetail records WHAT was closed, not just that something was:
// the operation id makes the journal entry traceable to Telemt's own
// operation, and the selector summary is what an operator reading the
// journal a week later actually needs.
func webCloseAuditDetail(selector telemt.WebCloseSelector, op telemt.WebControlOperationStatus) string {
	parts := []string{"operation=" + op.OperationID}
	switch selector.Kind {
	case telemt.WebCloseSelectorRefs:
		parts = append(parts, "refs="+strconv.Itoa(len(selector.SessionRefs)))
	case telemt.WebCloseSelectorFilter:
		for _, pair := range [][2]string{
			{"session_ref", selector.SessionRef}, {"ip", selector.IP}, {"host", selector.Host},
			{"user", selector.User}, {"user_agent_id", selector.UserAgentID},
			{"key_id", selector.KeyID}, {"carrier", selector.Carrier}, {"state", selector.State},
		} {
			if pair[1] != "" {
				parts = append(parts, pair[0]+"="+pair[1])
			}
		}
	}
	return strings.Join(parts, " ")
}
