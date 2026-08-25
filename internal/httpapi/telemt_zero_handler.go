package httpapi

import (
	"context"
	"net/http"
)

// handleGetTelemtZero implements GET /api/telemt/zero: a passthrough of
// Telemt's GET /v1/stats/zero/all deep counter dump (07-telemt-sdk.md §07:
// "core/upstream/middle_proxy/pool/desync"). This is the data source for the
// web frontend's "Диагностика → Счётчики" page (Task 6 of the M3 frontend
// plan) — no panel endpoint exposed telemt.ZeroAll before this, so the page
// had nothing to fetch; added as the smallest possible contract-gap fix
// (one read-only passthrough handler, no new capability flag) rather than
// routing the gap back to a future task, since the page is a required
// deliverable of that task.
func (s *Server) handleGetTelemtZero(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), telemtConfigRequestTimeout)
	defer cancel()

	data, err := s.tc.ZeroAll(ctx)
	if err != nil {
		// capabilityGated=true: zero/all is gated behind minimal_runtime_enabled
		// on Telemt's side (07-telemt-sdk.md) and, like the reload endpoints,
		// may be entirely absent on an old build — both surface as a bare
		// 404/405 that writeTelemtError's capabilityGated branch reports as
		// 501 capability_absent rather than a misleading 502.
		writeTelemtError(w, err, true)
		return
	}
	writeJSON(w, http.StatusOK, data)
}
