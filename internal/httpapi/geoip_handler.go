package httpapi

import (
	"errors"
	"net/http"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/geoip"
)

type geoIPDatabaseConfigRequest struct {
	Enabled  *bool   `json:"enabled"`
	Location *string `json:"location"`
}

type geoIPConfigRequest struct {
	Enabled  *bool                       `json:"enabled"`
	Source   *geoip.Source               `json:"source"`
	Schedule *geoip.Schedule             `json:"schedule"`
	Country  *geoIPDatabaseConfigRequest `json:"country"`
	ASN      *geoIPDatabaseConfigRequest `json:"asn"`
	City     *geoIPDatabaseConfigRequest `json:"city"`
}

func (r *geoIPConfigRequest) config() (geoip.Config, bool) {
	if r == nil || r.Enabled == nil || r.Source == nil || r.Schedule == nil ||
		!completeGeoIPDatabaseConfig(r.Country) || !completeGeoIPDatabaseConfig(r.ASN) ||
		!completeGeoIPDatabaseConfig(r.City) {
		return geoip.Config{}, false
	}
	return geoip.Config{
		Enabled: *r.Enabled, Source: *r.Source, Schedule: *r.Schedule,
		Country: geoip.DatabaseConfig{Enabled: *r.Country.Enabled, Location: *r.Country.Location},
		ASN:     geoip.DatabaseConfig{Enabled: *r.ASN.Enabled, Location: *r.ASN.Location},
		City:    geoip.DatabaseConfig{Enabled: *r.City.Enabled, Location: *r.City.Location},
	}, true
}

func completeGeoIPDatabaseConfig(r *geoIPDatabaseConfigRequest) bool {
	return r != nil && r.Enabled != nil && r.Location != nil
}

func (s *Server) handleGetGeoIPSettings(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if s.geoip == nil {
		writeJSON(w, http.StatusOK, geoip.Settings{Config: geoip.DefaultConfig(), Status: geoip.DisabledStatus()})
		return
	}
	writeJSON(w, http.StatusOK, s.geoip.Settings())
}

func (s *Server) handlePutGeoIPSettings(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var request *geoIPConfigRequest
	if err := decodeJSONBody(w, r, &request, jsonBodyOptions{MaxBytes: 64 << 10, RejectUnknown: true}); err != nil {
		if errors.Is(err, errJSONBodyTrailingData) {
			auth.WriteError(w, http.StatusBadRequest, "bad_request", "expected a single GeoIP configuration")
		} else {
			auth.WriteError(w, http.StatusBadRequest, "bad_request", "invalid GeoIP configuration")
		}
		return
	}
	cfg, complete := request.config()
	if !complete {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "invalid GeoIP configuration")
		return
	}
	if s.geoip == nil {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "GeoIP manager is unavailable")
		return
	}
	result, err := s.geoip.PutConfig(cfg)
	if err != nil {
		writeGeoIPError(w, err)
		return
	}
	// Only record the operation, never user paths or URLs with private queries.
	s.appendAudit(r, "geoip.settings_change", "panel", "")
	writeJSON(w, http.StatusAccepted, result)
}

func (s *Server) handleUpdateGeoIP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if s.geoip == nil {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "GeoIP manager is unavailable")
		return
	}
	result, err := s.geoip.Update()
	if err != nil {
		writeGeoIPError(w, err)
		return
	}
	s.appendAudit(r, "geoip.update", "panel", "")
	writeJSON(w, http.StatusAccepted, result)
}

func writeGeoIPError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, geoip.ErrBusy):
		auth.WriteError(w, http.StatusConflict, "conflict", "a GeoIP operation is already running")
	case errors.Is(err, geoip.ErrInvalidConfig), errors.Is(err, geoip.ErrDisabled):
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "invalid or disabled GeoIP configuration")
	default:
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not apply GeoIP configuration")
	}
}
