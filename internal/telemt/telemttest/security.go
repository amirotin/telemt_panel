package telemttest

import (
	"net/http"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

func (s *Server) handlePosture(w http.ResponseWriter) {
	writeOK(w, http.StatusOK, telemt.SecurityPostureData{
		APIReadOnly: s.scenario.ReadOnly, APIWhitelistEnabled: true, APIWhitelistEntries: 1,
		APIAuthHeaderEnabled: true, LogLevel: "info", TelemetryCoreEnabled: true, TelemetryMeLevel: "basic",
	}, s.revision())
}

func (s *Server) handleWhitelist(w http.ResponseWriter) {
	writeOK(w, http.StatusOK, telemt.SecurityWhitelistData{
		GeneratedAtEpochSecs: 5000, Enabled: true, EntriesTotal: 1, Entries: []string{"127.0.0.0/8"},
	}, s.revision())
}
