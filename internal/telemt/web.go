package telemt

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
)

// WEB session listing bounds, mirroring Telemt's own constants
// (api/web_runtime/request.rs: DEFAULT_SESSION_LIMIT / MAX_SESSION_LIMIT).
// The SDK rejects an out-of-range limit locally so a mistyped page size is a
// programming error here rather than a round trip that 400s.
const (
	WebSessionsDefaultLimit = 50
	WebSessionsMaxLimit     = 200
)

// WebSessionsQuery is the filter set GET /v1/runtime/web/sessions accepts.
// Telemt rejects any other or repeated query field with 400, so this struct
// IS the whitelist — httpapi's passthrough validates against the same list.
//
// SessionRef is a point lookup and is mutually exclusive with Cursor and
// Limit — Telemt rewrites it into `cursor = id-1, limit = 1` and 400s the
// combination. httpapi's parseWebSessionsQuery rejects it before the request
// is built, and telemttest reproduces the rewrite, so the two agree.
type WebSessionsQuery struct {
	Limit       int
	Cursor      string
	SessionRef  string
	IP          string
	Host        string
	User        string
	UserAgentID string
	KeyID       string
	Carrier     string
	State       string
}

// encode renders the query in a fixed field order. Empty values are omitted
// entirely: Telemt validates `host`/`user`/`ip` for non-empty content, so
// sending `&host=` would turn "no filter" into a 400.
func (q WebSessionsQuery) encode() string {
	values := url.Values{}
	if q.Limit > 0 {
		values.Set("limit", strconv.Itoa(q.Limit))
	}
	for _, pair := range [][2]string{
		{"cursor", q.Cursor},
		{"session_ref", q.SessionRef},
		{"ip", q.IP},
		{"host", q.Host},
		{"user", q.User},
		{"user_agent_id", q.UserAgentID},
		{"key_id", q.KeyID},
		{"carrier", q.Carrier},
		{"state", q.State},
	} {
		if pair[1] != "" {
			values.Set(pair[0], pair[1])
		}
	}
	return values.Encode()
}

// WebStatus calls GET /v1/runtime/web/status (Telemt >= 3.5.3).
//
// Not a Gated[T]: this route answers 200 even when WEB is off, reporting the
// closure through Available/Reason instead (see WebStatusData). A build that
// predates the route answers a bare 404, which the caller maps to
// `unsupported` — rule R5, the same split isRouteAbsent draws.
func (c *Client) WebStatus(ctx context.Context) (WebStatusData, error) {
	return get[WebStatusData](ctx, c, "/v1/runtime/web/status")
}

// WebSessions calls GET /v1/runtime/web/sessions with the given filters.
// A zero Limit lets Telemt apply its own default (50).
func (c *Client) WebSessions(ctx context.Context, query WebSessionsQuery) (WebSessionPage, error) {
	if query.Limit < 0 || query.Limit > WebSessionsMaxLimit {
		return WebSessionPage{}, fmt.Errorf("telemt: web sessions limit %d out of range 1..%d", query.Limit, WebSessionsMaxLimit)
	}
	path := "/v1/runtime/web/sessions"
	if encoded := query.encode(); encoded != "" {
		path += "?" + encoded
	}
	return get[WebSessionPage](ctx, c, path)
}

// WebSession calls GET /v1/runtime/web/sessions/{ref}.
//
// Three outcomes, only one of which is an error. Telemt answers a retained
// closed session with HTTP 410 carrying an ORDINARY success envelope
// (`{ok:true,data:{session_ref,state:"closed",attempt}}`), so decoding the
// payload alone would silently produce a WebSessionRow with 22 zeroed
// fields and a `state` of "closed" — indistinguishable from a live session
// that happens to be closing. The status is the discriminator, which is why
// this method reaches for callStatus rather than get[T].
func (c *Client) WebSession(ctx context.Context, ref string) (WebSessionResult, error) {
	if ref == "" {
		return WebSessionResult{}, errors.New("telemt: web session ref is empty")
	}
	path := "/v1/runtime/web/sessions/" + url.PathEscape(ref)
	data, status, _, err := c.callStatus(ctx, http.MethodGet, path, nil, "")
	if err != nil {
		return WebSessionResult{}, err
	}
	if status == http.StatusGone {
		var closed WebSessionClosed
		if err := json.Unmarshal(data, &closed); err != nil {
			return WebSessionResult{}, fmt.Errorf("telemt: decode %s tombstone: %w", path, err)
		}
		return WebSessionResult{Closed: &closed}, nil
	}
	var row WebSessionRow
	if err := json.Unmarshal(data, &row); err != nil {
		return WebSessionResult{}, fmt.Errorf("telemt: decode %s: %w", path, err)
	}
	normalizeSlices(&row)
	return WebSessionResult{Row: &row}, nil
}

// WebSessionsClose calls POST /v1/runtime/web/sessions/close and returns the
// accepted operation (202). Poll it with WebOperation.
//
// Telemt's control routes are stricter than the rest of its API and the
// request is built to match exactly: no query string at all, exactly one
// `Content-Type: application/json` header (callStatus uses Header.Set, so a
// duplicate is impossible by construction), and a mandatory
// `runtime_instance` that fences the request to the process the caller read
// the status from — a restarted proxy answers 409 web_runtime_mismatch
// rather than closing whatever now holds those ids. The body is encoded
// with `deny_unknown_fields` on the far side, so WebCloseSelector omits
// every field the chosen Kind does not use.
func (c *Client) WebSessionsClose(ctx context.Context, req WebCloseRequest) (WebControlOperationStatus, error) {
	if req.RuntimeInstance == "" {
		return WebControlOperationStatus{}, errors.New("telemt: web close: runtime_instance is required")
	}
	if req.Selector.Kind == "" {
		return WebControlOperationStatus{}, errors.New("telemt: web close: selector kind is required")
	}
	return mutate[WebControlOperationStatus](ctx, c, http.MethodPost, "/v1/runtime/web/sessions/close", req)
}

// WebOperation calls GET /v1/runtime/web/operations/{id}. Telemt retains the
// last 32 statuses; an older id answers 404 web_operation_not_found.
func (c *Client) WebOperation(ctx context.Context, id string) (WebControlOperationStatus, error) {
	if id == "" {
		return WebControlOperationStatus{}, errors.New("telemt: web operation id is empty")
	}
	return get[WebControlOperationStatus](ctx, c, "/v1/runtime/web/operations/"+url.PathEscape(id))
}

// IsWebRouteAbsent reports whether err says this Telemt build has no WEB
// runtime routes at all (< 3.5.3). Rule R5's `unsupported` vs `disabled`
// split starts here.
//
// The excluded codes are the WEB group's OWN 404s — web_session_not_found,
// web_operation_not_found — where the route exists and the thing behind it
// does not. Everything else that answers 404 is the router saying it has no
// such path.
//
// `not_found` used to be excluded alongside them, on the assumption that an
// old build answers "a bare 404 with no envelope". A live 3.4.25 does not:
// GET /v1/runtime/web/status there returns a perfectly well-formed
// `{"ok":false,"error":{"code":"not_found","message":"Route not found"}}`,
// which is that build's generic router 404 — exactly the case this
// predicate exists to catch. Excluding it turned the panel's «Нет в этой
// версии» card into a topic-wide `telemt_unreachable` error on every proxy
// too old to have WEB at all.
//
// 405 is deliberately excluded. On 3.5.3+ every WEB path has an entry in
// `allowed_methods`, so a 405 means "wrong method on a route that exists" —
// a panel bug — and reading it as "old build" would tell the operator to
// upgrade Telemt for it.
func IsWebRouteAbsent(err error) bool {
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		return false
	}
	switch apiErr.Code {
	case CodeWebSessionNotFound, CodeWebOperationNotFound:
		return false
	}
	return apiErr.Status == http.StatusNotFound
}

// IsWebRuntimeUnavailable reports whether err is the 503 the sessions/close/
// operations routes answer while the WEB runtime is not running. The panel
// renders it as a closed capability with Telemt's own lifecycle token as the
// reason, never as a failure (rule R5).
func IsWebRuntimeUnavailable(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Code == CodeWebRuntimeUnavailable
}
