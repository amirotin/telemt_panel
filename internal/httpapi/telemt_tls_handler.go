package httpapi

import (
	"context"
	"net/http"
	"strconv"

	"github.com/amirotin/telemt_panel/internal/auth"
)

// TLS fingerprint limit bounds for GET /api/telemt/tls-fingerprints.
//
// defaultTLSFingerprintsLimit mirrors the working set the live snapshot
// documents (TELEMT_LIVE_API_DATA.md §19: four collections of 50 records,
// ~120 KB). Telemt's own default for this route is its configured
// runtime_edge_top_n, so the panel always sends an explicit limit rather
// than inheriting a server-side value it cannot predict.
// maxTLSFingerprintsLimit is the panel's own guard (Telemt caps at 1000):
// the payload grows linearly with the limit, so an admin cannot ask the
// browser for a multi-megabyte response by hand-editing the query string.
const (
	defaultTLSFingerprintsLimit = 50
	maxTLSFingerprintsLimit     = 500
)

// handleGetTelemtTLSFingerprints implements GET
// /api/telemt/tls-fingerprints?limit=N: a passthrough of Telemt's GET
// /v1/runtime/tls-fingerprints. This is the fetch-on-visit replacement for
// the "security" topic's former tls_fingerprints field (owner ruling
// 2026-08-26): the payload is the largest single Telemt endpoint (~120 KB)
// and has no business being re-polled every 30s for every connected client.
//
// The runtime_edge capability gate reports 503 capability_unavailable, the
// same code /api/telemt/config's requireConfigAPI uses, so the frontend
// renders its Gated hint instead of an error toast. Unlike that handler the
// gate is read off the response itself (`enabled:false`, which Telemt sets
// for this route only when runtime_edge_enabled is off — api/runtime_edge.rs
// build_runtime_tls_fingerprints_data) rather than from a Capabilities()
// probe: probeRuntimeEdge deliberately degrades to false when Telemt cannot
// be reached at all, so an up-front probe would report an unreachable
// backend as "capability off" and break the API-only degradation invariant
// (unreachable must stay 502 telemt_unreachable — see TestAPIOnlyDegradation).
func (s *Server) handleGetTelemtTLSFingerprints(w http.ResponseWriter, r *http.Request) {
	limit := defaultTLSFingerprintsLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > maxTLSFingerprintsLimit {
			auth.WriteError(w, http.StatusBadRequest, "bad_request", "limit must be an integer between 1 and "+strconv.Itoa(maxTLSFingerprintsLimit))
			return
		}
		limit = parsed
	}

	ctx, cancel := context.WithTimeout(r.Context(), telemtConfigRequestTimeout)
	defer cancel()

	data, err := s.tc.TLSFingerprints(ctx, limit)
	if err != nil {
		// capabilityGated=true: an old Telemt build predating the runtime
		// edge routes does not register this path at all, which surfaces as
		// a bare 404/405 that writeTelemtError reports as 501
		// capability_absent rather than a misleading 502 — same treatment
		// as /api/telemt/zero.
		writeTelemtError(w, err, true)
		return
	}
	if !data.Enabled {
		message := "telemt build/config does not expose runtime edge data (runtime_edge_enabled is off)"
		if data.Reason != "" {
			message += ": " + data.Reason
		}
		auth.WriteError(w, http.StatusServiceUnavailable, "capability_unavailable", message)
		return
	}
	writeJSON(w, http.StatusOK, data)
}
