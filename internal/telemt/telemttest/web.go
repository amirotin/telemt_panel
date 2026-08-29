package telemttest

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

// The fake's WEB runtime (Telemt >= 3.5.3, `/v1/runtime/web/*`).
//
// The status payload's `limits` and `debug.policy` blocks are copied
// verbatim from a real GET /v1/runtime/web/status recorded off a local
// Telemt 3.5.5 with a WEB listener configured — a hand-shortened version
// would make every screenshot taken against this mock lie about the size of
// the block the Details page has to lay out.
const (
	webRuntimeInstance = "0123456789abcdef0123456789abcdef"

	webLimitsJSON = `{"max_header_bytes":16384,"max_body_bytes":2097152,"max_frame_payload_bytes":1048576,` +
		`"carrier_batch_bytes":2097152,"max_frames_per_body":4096,"max_http_connections":1024,"max_http_handlers":512,` +
		`"max_lane_open_waits_per_session":16,"pending_bytes_per_lane":8388608,"pending_items_per_lane":1024,` +
		`"websocket_bytes_global":268435456,"websocket_admission_watermark_pct":75,"websocket_eviction_watermark_pct":90,` +
		`"websocket_http_connection_reserve":64,"max_websocket_evictions_in_flight":8,"max_carrier_learning_entries":4096,` +
		`"max_body_readers":32,"max_body_bytes_global":67108864,"max_sessions_global":128,"max_sessions_per_ip":16,` +
		`"max_streams_per_session":128,"max_streams_global":4096,"max_stream_handshakes":256,"max_tombstones_per_session":4096,` +
		`"pending_bytes_per_session":33554432,"pending_bytes_global":536870912,"pending_items_per_session":16384,` +
		`"pending_items_global":262144,"control_bytes_per_session":262144,"control_bytes_global":16777216,` +
		`"max_bootstraps_global":512,"max_bootstraps_per_ip":64,"max_vhosts":8,"max_profiles":32,"max_static_files":4096,` +
		`"max_static_file_bytes":8388608,"max_static_bytes":67108864,"debug_records_capacity":65536,` +
		`"debug_bytes_global":67108864,"memory_envelope_bytes":1342177280,"new_bootstraps_per_minute":1200,` +
		`"new_bootstraps_burst":256,"new_sessions_per_minute":600,"new_sessions_burst":128,` +
		`"new_streams_per_minute":6000,"new_streams_burst":512}`

	webDebugPolicyJSON = `{"enabled":false,"capture_lifecycle":true,"capture_headers":true,"capture_timings":true,` +
		`"capture_frames":true,"body_capture":"metadata","body_prefix_bytes":4096,"decoy_body_prefix_bytes":4096,` +
		`"default_window_secs":180,"max_window_secs":3600}`
)

// webSessionCount is how many sessions the fake seeds. Above the frontend's
// 20-per-reveal window on purpose: cursor paging ("Показать ещё") is a real
// second request, and a fake that always fits on one page would never
// exercise it.
const webSessionCount = 24

// webSeedSessions builds the fake's session registry deterministically —
// no clock, no randomness, so two runs produce byte-identical screenshots.
// The spread over carriers, states, users and IPs is what gives the
// Sessions tab's filters something to filter.
func webSeedSessions() []telemt.WebSessionRow {
	carriers := []string{"https-lanes", "websocket", "https", "websocket-lanes"}
	states := []string{"healthy", "committed", "provisional", "closing"}
	classes := []string{"bridge", "legacy", "browser-hint", "ios"}
	users := []string{"web-user", "alice"}
	agents := []string{
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) TelegramDesktop/5.7.2",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) TelegramDesktop/5.7.2",
		"",
	}

	rows := make([]telemt.WebSessionRow, 0, webSessionCount)
	for i := 1; i <= webSessionCount; i++ {
		agent := agents[i%len(agents)]
		row := telemt.WebSessionRow{
			SessionRef: webSessionRef(uint64(i)),
			UserAgent:  agent,
			WebSessionStatus: telemt.WebSessionStatus{
				TraceSessionID:            uint64(i),
				ClientIP:                  fmt.Sprintf("203.0.113.%d", 10+i),
				Host:                      "proxy.example.com",
				User:                      users[i%len(users)],
				KeyID:                     fmt.Sprintf("%016x", 0xa100+i),
				Carrier:                   carriers[i%len(carriers)],
				Attempt:                   uint8(1 + i%3),
				ClientClass:               classes[i%len(classes)],
				Automatic:                 i%2 == 0,
				State:                     states[i%len(states)],
				Streams:                   i % 5,
				Tasks:                     i % 4,
				Lanes:                     i % 6,
				LaneOpenWaits:             i % 2,
				WebsocketLaneReservations: i % 3,
				WebsocketActive:           strings.HasPrefix(carriers[i%len(carriers)], "websocket"),
				PendingBytes:              1024 * i,
				PendingItems:              i,
				ControlBytes:              64 * i,
				ControlItems:              i % 7,
				AgeMs:                     uint64(60_000 * i),
				IdleMs:                    uint64(250 * i),
			},
		}
		if agent != "" {
			row.UserAgentID = fmt.Sprintf("%032x", 0xb200+i)
		}
		// Only a session still negotiating its carrier has a remaining
		// budget; the field is omitted for everybody else.
		if row.State == "provisional" {
			remaining := uint64(4200 - 100*i)
			row.NegotiationRemainingMs = &remaining
		}
		rows = append(rows, row)
	}
	return rows
}

func webSessionRef(id uint64) string {
	return fmt.Sprintf("ws1.%s.%016x", webRuntimeInstance, id)
}

func webOperationID(seq uint64) string {
	return fmt.Sprintf("wo1.%s.%016x", webRuntimeInstance, seq)
}

// webRuntimeUnavailable is the 503 the sessions/close/operations routes
// answer while the WEB runtime is not running — Scenario.WebOff.
func webRuntimeUnavailable(w http.ResponseWriter) {
	writeErr(w, http.StatusServiceUnavailable, telemt.CodeWebRuntimeUnavailable,
		"WEB runtime is unavailable: no_web_listener")
}

// handleWebStatus serves GET /v1/runtime/web/status. It never fails: a
// closed WEB runtime is reported in the payload's own fields, which is
// exactly what the real route does.
func (s *Server) handleWebStatus(w http.ResponseWriter) {
	if s.scenario.WebOff {
		writeOK(w, http.StatusOK, telemt.WebStatusData{
			Lifecycle:      telemt.WebLifecycleNoWebListener,
			LifecycleEpoch: 2,
			LifecycleAgeMs: 755,
			Available:      false,
			Reason:         "no_web_listener",
			Listeners:      []string{},
		}, s.revision())
		return
	}

	live, closed := 0, 0
	for _, row := range s.webSessions {
		if row.State == "closed" {
			closed++
			continue
		}
		live++
	}

	learningEpoch := uint64(1)
	writeOK(w, http.StatusOK, telemt.WebStatusData{
		Lifecycle:              telemt.WebLifecycleRunning,
		LifecycleEpoch:         2,
		LifecycleAgeMs:         7762,
		Available:              true,
		Listeners:              []string{"127.0.0.1:18080"},
		EffectiveConfigEnabled: true,
		Runtime: &telemt.WebRuntimeStatus{
			RuntimeInstance: webRuntimeInstance,
			GenerationID:    1,
			Limits:          json.RawMessage(webLimitsJSON),
			Manager: &telemt.WebManagerStatus{
				IssuanceEnabled: true, IssuanceGeneration: 1,
				Bootstraps: 2, Sessions: live, ClosedTokens: closed,
				ClosedSessions: closed, ClientIPs: live, Profiles: 1,
			},
			Streams: &telemt.WebStreamStatus{Live: live * 2, Profiles: 1},
			Budget: &telemt.WebBudgetStatus{
				QueueBytes: 1 << 20, QueueItems: 42, ControlBytes: 4096, ControlItems: 7,
				WebsocketBytes: 1 << 18, HighWaterBytes: 3 << 20, Owners: live,
			},
			Websockets: &telemt.WebSocketStatus{Entries: 6, Claims: 6},
			Learning: &telemt.WebLearningStatus{
				Aggressiveness: "conservative", Epoch: &learningEpoch,
				Capacity: 4096, LifetimeSecs: 600, AgeMs: 7762,
			},
			Debug: &telemt.WebDebugStatus{
				Policy: json.RawMessage(webDebugPolicyJSON), PolicyGeneration: 1, Epoch: 1,
				RecordsCapacity: 65536, BytesCapacity: 67108864,
			},
			Permits: []telemt.WebPermit{
				{Name: "http_connections", Status: telemt.WebPermitStatus{Used: 6, Available: 1018, Capacity: 1024}},
				{Name: "http_handlers", Status: telemt.WebPermitStatus{Used: 4, Available: 508, Capacity: 512}},
				{Name: "lane_polls", Status: telemt.WebPermitStatus{Used: 3, Available: 253, Capacity: 256}},
				{Name: "lane_aux_polls", Status: telemt.WebPermitStatus{Used: 0, Available: 128, Capacity: 128}},
				{Name: "body_readers", Status: telemt.WebPermitStatus{Used: 1, Available: 31, Capacity: 32}},
				{Name: "body_bytes", Status: telemt.WebPermitStatus{Used: 65536, Available: 67043328, Capacity: 67108864}},
				{Name: "stream_handshakes", Status: telemt.WebPermitStatus{Used: 0, Available: 256, Capacity: 256}},
				{Name: "websocket_connections", Status: telemt.WebPermitStatus{Used: 6, Available: 954, Capacity: 960}},
			},
			AuxiliaryTasks:             1,
			SessionIncarnationsCreated: uint64(webSessionCount),
			SessionIncarnationsClosed:  uint64(closed),
			StreamsOpened:              uint64(live * 3),
			StreamsRejected:            2,
			BytesUp:                    12_345_678,
			BytesDown:                  98_765_432,
			LimitHits:                  3,
			Partial:                    []string{},
		},
	}, s.revision())
}

// webSessionFilters is the exact query whitelist of the real route; any
// other or repeated name is a 400 there and here.
var webSessionFilters = map[string]struct{}{
	"limit": {}, "cursor": {}, "session_ref": {}, "ip": {}, "host": {},
	"user": {}, "user_agent_id": {}, "key_id": {}, "carrier": {}, "state": {},
}

// handleWebSessions serves GET /v1/runtime/web/sessions with the real
// route's filter/cursor semantics: an ordered scan over ascending session
// ids, `cursor` an exclusive lower bound, and a `next_cursor` only when the
// page filled up.
func (s *Server) handleWebSessions(w http.ResponseWriter, rawQuery string) {
	if s.scenario.WebOff {
		webRuntimeUnavailable(w)
		return
	}
	values, err := url.ParseQuery(rawQuery)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "Invalid query")
		return
	}
	for name, vals := range values {
		if _, ok := webSessionFilters[name]; !ok {
			writeErr(w, http.StatusBadRequest, "bad_request", "unknown query field `"+name+"`")
			return
		}
		if len(vals) > 1 {
			writeErr(w, http.StatusBadRequest, "bad_request", name+" must not repeat")
			return
		}
		// Every one of the ten names validates its value for non-empty
		// content in the real route, so an empty one is a 400 there and
		// must be a 400 here — otherwise the panel's own rejection would
		// have nothing to be checked against.
		if vals[0] == "" {
			writeErr(w, http.StatusBadRequest, "bad_request", name+" must not be empty")
			return
		}
	}
	if values.Has("session_ref") && (values.Has("cursor") || values.Has("limit")) {
		writeErr(w, http.StatusBadRequest, "bad_request",
			"session_ref must not be combined with cursor or limit")
		return
	}

	limit := telemt.WebSessionsDefaultLimit
	if raw := values.Get("limit"); raw != "" {
		parsed, convErr := strconv.Atoi(raw)
		if convErr != nil || parsed < 1 || parsed > telemt.WebSessionsMaxLimit {
			writeErr(w, http.StatusBadRequest, "bad_request", "limit must be within 1..200")
			return
		}
		limit = parsed
	}
	after := uint64(0)
	if cursor := values.Get("cursor"); cursor != "" {
		id, ok := webRefID(cursor)
		if !ok {
			writeErr(w, http.StatusBadRequest, "bad_request", "Invalid WEB session reference")
			return
		}
		after = id
	}
	// A session_ref is not an equality filter in Telemt: it is rewritten
	// into a one-row window opened just below the id it names, which is
	// what makes `scanned`/`next_cursor` come back the way they do. A fake
	// that matched it as a plain filter would report a different scan than
	// the real route for the same request.
	if ref := values.Get("session_ref"); ref != "" {
		id, ok := webRefID(ref)
		if !ok {
			writeErr(w, http.StatusBadRequest, "bad_request", "Invalid WEB session reference")
			return
		}
		after = id - 1
		limit = 1
	}

	page := telemt.WebSessionPage{Sessions: []telemt.WebSessionRow{}, Partial: []string{}}
	rows := s.webSessionsSorted()
	for _, row := range rows {
		if row.TraceSessionID <= after {
			continue
		}
		page.Scanned++
		if !webRowMatches(row, values) {
			continue
		}
		page.Sessions = append(page.Sessions, row)
		if len(page.Sessions) == limit {
			cursor := webSessionRef(row.TraceSessionID)
			page.NextCursor = &cursor
			break
		}
	}
	writeOK(w, http.StatusOK, page, s.revision())
}

func webRowMatches(row telemt.WebSessionRow, values url.Values) bool {
	if row.State == "closed" {
		// A closed session survives only as a tombstone on the detail
		// route; it never appears in a listing.
		return false
	}
	for name, want := range map[string]string{
		"ip": row.ClientIP, "host": row.Host, "user": row.User,
		"user_agent_id": row.UserAgentID, "key_id": row.KeyID,
		"carrier": row.Carrier, "state": row.State,
		"session_ref": row.SessionRef,
	} {
		if got := values.Get(name); got != "" && got != want {
			return false
		}
	}
	return true
}

func (s *Server) webSessionsSorted() []telemt.WebSessionRow {
	rows := append([]telemt.WebSessionRow(nil), s.webSessions...)
	sort.Slice(rows, func(i, j int) bool { return rows[i].TraceSessionID < rows[j].TraceSessionID })
	return rows
}

// webRefID parses the canonical `ws1.<instance>.<16 hex>` form and returns
// the non-zero id it carries.
func webRefID(ref string) (uint64, bool) {
	parts := strings.Split(ref, ".")
	if len(parts) != 3 || parts[0] != "ws1" || parts[1] != webRuntimeInstance || len(parts[2]) != 16 {
		return 0, false
	}
	id, err := strconv.ParseUint(parts[2], 16, 64)
	if err != nil || id == 0 {
		return 0, false
	}
	return id, true
}

// handleWebSession serves GET /v1/runtime/web/sessions/{ref}: the live row,
// or a 410 tombstone inside a SUCCESS envelope for a session this fake has
// already closed, or 404.
func (s *Server) handleWebSession(w http.ResponseWriter, ref string) {
	if s.scenario.WebOff {
		webRuntimeUnavailable(w)
		return
	}
	id, ok := webRefID(ref)
	if !ok {
		writeErr(w, http.StatusBadRequest, "bad_request", "Invalid WEB session reference")
		return
	}
	for _, row := range s.webSessions {
		if row.TraceSessionID != id {
			continue
		}
		if row.State == "closed" {
			writeOK(w, http.StatusGone, telemt.WebSessionClosed{
				SessionRef: row.SessionRef, State: "closed", Attempt: row.Attempt,
			}, s.revision())
			return
		}
		writeOK(w, http.StatusOK, row, s.revision())
		return
	}
	writeErr(w, http.StatusNotFound, telemt.CodeWebSessionNotFound, "No such WEB session")
}

// handleWebSessionsClose serves POST /v1/runtime/web/sessions/close with
// the real route's preconditions in the real order: read-only, no query,
// exactly one byte-exact JSON content type, unknown fields rejected, and
// the runtime fence.
func (s *Server) handleWebSessionsClose(w http.ResponseWriter, r *http.Request, rawQuery string) {
	if s.scenario.ReadOnly {
		writeReadOnly(w)
		return
	}
	if rawQuery != "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "Query parameters are not accepted")
		return
	}
	if ct := r.Header.Values("Content-Type"); len(ct) != 1 || ct[0] != "application/json" {
		writeErr(w, http.StatusUnsupportedMediaType, telemt.CodeUnsupportedMediaType,
			"Content-Type must be exactly one application/json")
		return
	}
	if s.scenario.WebOff {
		webRuntimeUnavailable(w)
		return
	}

	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, int64(s.bodyLimit())))
	decoder.DisallowUnknownFields()
	var req telemt.WebCloseRequest
	if err := decoder.Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "Invalid JSON body")
		return
	}
	if req.RuntimeInstance != webRuntimeInstance {
		if len(req.RuntimeInstance) != 32 {
			writeErr(w, http.StatusBadRequest, "bad_request",
				"runtime_instance must be 32 lowercase hexadecimal characters")
			return
		}
		writeErr(w, http.StatusConflict, telemt.CodeWebRuntimeMismatch,
			"runtime_instance belongs to another WEB runtime")
		return
	}

	matched, err := s.webSelect(req.Selector)
	if err != nil {
		writeErr(w, err.status, err.code, err.message)
		return
	}

	closed := 0
	for i := range s.webSessions {
		if _, ok := matched[s.webSessions[i].TraceSessionID]; !ok {
			continue
		}
		if s.webSessions[i].State == "closed" {
			continue
		}
		s.webSessions[i].State = "closed"
		closed++
	}

	s.nextWebOperation++
	requested := 0
	if req.Selector.Kind == telemt.WebCloseSelectorRefs {
		requested = len(req.Selector.SessionRefs)
	}
	highWater := webSessionRef(uint64(len(s.webSessions)))
	op := telemt.WebControlOperationStatus{
		OperationID:         webOperationID(s.nextWebOperation),
		State:               telemt.WebOperationQueued,
		HighWaterSessionRef: &highWater,
		Requested:           requested,
		CreatedEpochMillis:  webOperationEpochMillis,
		UpdatedEpochMillis:  webOperationEpochMillis,
	}
	// The terminal status the poll will report. Recorded now so the fake
	// needs no timer: the first poll answers `completed`, which is both
	// deterministic for screenshots and a truthful shape (a close of a
	// handful of sessions really does finish inside one chunk).
	done := op
	done.State = telemt.WebOperationCompleted
	done.Scanned = len(s.webSessions)
	done.Matched = len(matched)
	done.CloseSignalled = closed
	done.Conflicted = len(matched) - closed
	done.UpdatedEpochMillis = webOperationEpochMillis + 500
	s.webOperations[op.OperationID] = done

	writeOK(w, http.StatusAccepted, op, s.revision())
}

// webOperationEpochMillis is a fixed wall clock for the fake's operation
// stamps — a real one would make every screenshot differ.
const webOperationEpochMillis = 1_756_000_000_000

type webSelectError struct {
	status  int
	code    string
	message string
}

// webSelect resolves a close selector to the set of session ids it matches,
// applying the real route's selector rules (bounded ref list, non-empty
// filter, `all` only while issuance is disabled).
func (s *Server) webSelect(selector telemt.WebCloseSelector) (map[uint64]struct{}, *webSelectError) {
	matched := map[uint64]struct{}{}
	switch selector.Kind {
	case telemt.WebCloseSelectorRefs:
		if len(selector.SessionRefs) == 0 || len(selector.SessionRefs) > telemt.WebSessionsMaxLimit {
			return nil, &webSelectError{http.StatusBadRequest, "bad_request", "session_refs must hold 1..200 entries"}
		}
		for _, ref := range selector.SessionRefs {
			id, ok := webRefID(ref)
			if !ok {
				return nil, &webSelectError{http.StatusBadRequest, "bad_request", "Invalid WEB session reference"}
			}
			if _, dup := matched[id]; dup {
				return nil, &webSelectError{http.StatusBadRequest, "bad_request", "session_refs must not contain duplicates"}
			}
			matched[id] = struct{}{}
		}
	case telemt.WebCloseSelectorFilter:
		values := url.Values{}
		for name, value := range map[string]string{
			"session_ref": selector.SessionRef, "ip": selector.IP, "host": selector.Host,
			"user": selector.User, "user_agent_id": selector.UserAgentID,
			"key_id": selector.KeyID, "carrier": selector.Carrier, "state": selector.State,
		} {
			if value != "" {
				values.Set(name, value)
			}
		}
		if len(values) == 0 {
			return nil, &webSelectError{http.StatusBadRequest, "bad_request", "filter selector requires at least one filter"}
		}
		for _, row := range s.webSessions {
			if webRowMatches(row, values) {
				matched[row.TraceSessionID] = struct{}{}
			}
		}
	case telemt.WebCloseSelectorAll:
		// Issuance is always enabled in this fake's status, so `all` is
		// always refused — exactly the guard an operator hits before
		// setting web.enabled = false.
		return nil, &webSelectError{http.StatusConflict, telemt.CodeWebIssuanceEnabled,
			"Close-all requires effective WEB issuance to be disabled"}
	default:
		return nil, &webSelectError{http.StatusBadRequest, "bad_request", "Invalid WEB control request"}
	}
	return matched, nil
}

// handleWebOperation serves GET /v1/runtime/web/operations/{id}.
func (s *Server) handleWebOperation(w http.ResponseWriter, id string) {
	if s.scenario.WebOff {
		webRuntimeUnavailable(w)
		return
	}
	op, ok := s.webOperations[id]
	if !ok {
		writeErr(w, http.StatusNotFound, telemt.CodeWebOperationNotFound, "No such WEB control operation")
		return
	}
	writeOK(w, http.StatusOK, op, s.revision())
}
