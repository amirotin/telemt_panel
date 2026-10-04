package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/geography"
)

func geographyParams(r *http.Request, allowed ...string) (url.Values, error) {
	q, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return nil, geography.ErrBadRequest
	}
	for k, v := range q {
		if len(v) != 1 || !containsParameter(allowed, k) {
			return nil, geography.ErrBadRequest
		}
	}
	return q, nil
}
func containsParameter(allowed []string, name string) bool {
	for _, a := range allowed {
		if a == name {
			return true
		}
	}
	return false
}
func geographyLimit(q url.Values) (int, error) {
	if !q.Has("limit") {
		return 50, nil
	}
	n, err := strconv.Atoi(q.Get("limit"))
	if err != nil || n < 1 || n > 100 {
		return 0, geography.ErrBadRequest
	}
	return n, nil
}
func (s *Server) geographyAvailable(w http.ResponseWriter) bool {
	w.Header().Set("Cache-Control", "no-store")
	if s.geography == nil {
		writeGeographyError(w, errors.New("service unavailable"))
		return false
	}
	return true
}

func (s *Server) handleGetGeography(w http.ResponseWriter, r *http.Request) {
	if !s.geographyAvailable(w) {
		return
	}
	q, err := geographyParams(r, "range", "family", "country", "location", "snapshot_id")
	if err == nil {
		for _, name := range []string{"range", "family", "country", "location", "snapshot_id"} {
			if q.Has(name) && q.Get(name) == "" {
				err = geography.ErrBadRequest
			}
		}
	}
	if err != nil {
		writeGeographyError(w, err)
		return
	}
	result, err := s.geography.Overview(r.Context(), geography.OverviewQuery{Range: geography.Range(q.Get("range")), Family: geography.Family(q.Get("family")), Country: q.Get("country"), LocationID: q.Get("location"), SnapshotID: q.Get("snapshot_id")})
	if err != nil {
		writeGeographyError(w, err)
		return
	}
	writeGeographyJSON(w, result, 256<<10)
}
func (s *Server) handleGetGeographyLocations(w http.ResponseWriter, r *http.Request) {
	if !s.geographyAvailable(w) {
		return
	}
	q, err := geographyParams(r, "snapshot_id", "kind", "country", "limit", "cursor")
	if err != nil {
		writeGeographyError(w, err)
		return
	}
	limit, err := geographyLimit(q)
	if err != nil {
		writeGeographyError(w, err)
		return
	}
	if q.Get("snapshot_id") == "" || q.Get("kind") == "" {
		writeGeographyError(w, geography.ErrBadRequest)
		return
	}
	result, err := s.geography.Locations(r.Context(), geography.LocationsQuery{SnapshotID: q.Get("snapshot_id"), Kind: q.Get("kind"), Country: q.Get("country"), Limit: limit, Cursor: q.Get("cursor")})
	if err != nil {
		writeGeographyError(w, err)
		return
	}
	writeGeographyJSON(w, result, 64<<10)
}
func (s *Server) handleGetGeographyUsers(w http.ResponseWriter, r *http.Request) {
	if !s.geographyAvailable(w) {
		return
	}
	q, err := geographyParams(r, "snapshot_id", "group_id", "limit", "cursor")
	if err != nil {
		writeGeographyError(w, err)
		return
	}
	limit, err := geographyLimit(q)
	if err != nil {
		writeGeographyError(w, err)
		return
	}
	result, err := s.geography.Users(r.Context(), geography.UsersQuery{SnapshotID: q.Get("snapshot_id"), GroupID: q.Get("group_id"), Limit: limit, Cursor: q.Get("cursor")})
	if err != nil {
		writeGeographyError(w, err)
		return
	}
	writeGeographyJSON(w, result, 64<<10)
}
func (s *Server) handleGetGeographySettings(w http.ResponseWriter, r *http.Request) {
	if !s.geographyAvailable(w) {
		return
	}
	if _, err := geographyParams(r); err != nil {
		writeGeographyError(w, err)
		return
	}
	result, err := s.geography.Settings(r.Context())
	if err != nil {
		writeGeographyError(w, err)
		return
	}
	writeGeographyJSON(w, result, 4<<10)
}
func (s *Server) handlePutGeographySettings(w http.ResponseWriter, r *http.Request) {
	if !s.geographyAvailable(w) {
		return
	}
	var request json.RawMessage
	if err := decodeJSONBody(w, r, &request, jsonBodyOptions{MaxBytes: 4 << 10, RejectUnknown: true}); err != nil {
		writeGeographyError(w, geography.ErrBadRequest)
		return
	}
	var body map[string]json.RawMessage
	if json.Unmarshal(request, &body) != nil || len(body) != 1 || body["server_location"] == nil {
		writeGeographyError(w, geography.ErrBadRequest)
		return
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(body["server_location"], &fields) != nil || len(fields) != 5 {
		writeGeographyError(w, geography.ErrBadRequest)
		return
	}
	for _, name := range []string{"mode", "label", "public_ip", "latitude", "longitude"} {
		if fields[name] == nil {
			writeGeographyError(w, geography.ErrBadRequest)
			return
		}
	}
	if string(fields["mode"]) == "null" || string(fields["label"]) == "null" {
		writeGeographyError(w, geography.ErrBadRequest)
		return
	}
	var settings geography.Settings
	d := json.NewDecoder(strings.NewReader(string(request)))
	d.DisallowUnknownFields()
	if d.Decode(&settings) != nil {
		writeGeographyError(w, geography.ErrBadRequest)
		return
	}
	result, err := s.geography.PutSettings(r.Context(), settings.ServerLocation)
	if err != nil {
		writeGeographyError(w, err)
		return
	}
	s.appendAudit(r, "geography.settings_change", "panel", "")
	writeGeographyJSON(w, result, 4<<10)
}

func writeGeographyJSON(w http.ResponseWriter, value any, limit int) {
	raw, err := json.Marshal(value)
	if err != nil {
		writeGeographyError(w, err)
		return
	}
	if len(raw)+1 > limit {
		writeGeographyError(w, geography.ErrCapacity)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(append(raw, '\n'))
}
func writeGeographyError(w http.ResponseWriter, err error) {
	w.Header().Set("Cache-Control", "no-store")
	status, code := http.StatusInternalServerError, "internal_error"
	switch {
	case errors.Is(err, geography.ErrBadRequest):
		status, code = 400, "bad_request"
	case errors.Is(err, geography.ErrNotFound):
		status, code = 404, "not_found"
	case errors.Is(err, geography.ErrSnapshotExpired):
		status, code = 409, "geography_snapshot_expired"
	case errors.Is(err, geography.ErrSourceChanged):
		status, code = 409, "geography_source_changed"
	case errors.Is(err, geography.ErrBusy):
		status, code = 503, "geography_busy"
		w.Header().Set("Retry-After", "5")
	case errors.Is(err, geography.ErrCapacity):
		status, code = 503, "geography_capacity"
	case errors.Is(err, geography.ErrTimeout):
		status, code = 504, "geography_timeout"
	}
	auth.WriteError(w, status, code, "could not complete geography request")
}
