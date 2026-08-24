package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

// telemtInfoRequestTimeout bounds GET /api/telemt/info's SystemInfo call
// plus the Capabilities probe that follows it on success.
const telemtInfoRequestTimeout = 10 * time.Second

// telemtCapabilitiesView mirrors api/openapi.yaml TelemtInfo.capabilities.
type telemtCapabilitiesView struct {
	Quota             bool `json:"quota"`
	RuntimeEdge       bool `json:"runtime_edge"`
	ReloadAPI         bool `json:"reload_api"`
	ConfigAPI         bool `json:"config_api"`
	UserEnableDisable bool `json:"user_enable_disable"`
	RotateSecret      bool `json:"rotate_secret"`
}

// telemtInfoView mirrors api/openapi.yaml schema TelemtInfo.
type telemtInfoView struct {
	Reachable bool   `json:"reachable"`
	Version   string `json:"version,omitempty"`
	Arch      string `json:"arch,omitempty"`
	OS        string `json:"os,omitempty"`
	// UptimeSeconds has no omitempty: a fresh-restart 0.0 is a legitimate
	// value and must not be dropped the way omitempty would drop it.
	UptimeSeconds  float64                `json:"uptime_seconds"`
	ConfigPath     string                 `json:"config_path,omitempty"`
	ConfigEditMode string                 `json:"config_edit_mode,omitempty"`
	Capabilities   telemtCapabilitiesView `json:"capabilities"`
	Hint           string                 `json:"hint,omitempty"`
}

// handleTelemtInfo implements GET /api/telemt/info: connectivity, version,
// and the capability flags 07-telemt-sdk.md §SDK-3 defines. Never fails —
// an unreachable Telemt is reported as reachable:false with an actionable
// hint, not an HTTP error, per the API-only degradation invariant: the hint
// always names the Telemt API (telemt.url/telemt.auth_header), never a
// file or config path, so it can never be confused with a host-privileges
// diagnostic (GET /api/host).
func (s *Server) handleTelemtInfo(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), telemtInfoRequestTimeout)
	defer cancel()

	sysInfo, err := s.tc.SystemInfo(ctx)
	if err != nil {
		var apiErr *telemt.APIError
		hint := "telemt api is unreachable — check telemt.url"
		if errors.As(err, &apiErr) && apiErr.Status == http.StatusUnauthorized {
			hint = "telemt api rejected authorization — check telemt.auth_header"
		}
		writeJSON(w, http.StatusOK, telemtInfoView{Reachable: false, Hint: hint})
		return
	}

	caps, err := s.tc.Capabilities(ctx)
	if err != nil {
		// Capabilities only returns an error for a canceled/expired ctx
		// (see capabilities.go); every probe failure degrades that one
		// flag internally instead. Still worth a log line rather than a
		// silently all-false capabilities object.
		slog.Warn("telemt/info: capabilities probe", "err", err)
	}

	writeJSON(w, http.StatusOK, telemtInfoView{
		Reachable:      true,
		Version:        sysInfo.Version,
		Arch:           sysInfo.TargetArch,
		OS:             sysInfo.TargetOS,
		UptimeSeconds:  sysInfo.UptimeSeconds,
		ConfigPath:     sysInfo.ConfigPath,
		ConfigEditMode: s.cfg.Telemt.ConfigEditMode,
		Capabilities: telemtCapabilitiesView{
			Quota:             caps.Quota,
			RuntimeEdge:       caps.RuntimeEdge,
			ReloadAPI:         caps.ReloadAPI,
			ConfigAPI:         caps.ConfigAPI,
			UserEnableDisable: caps.UserEnableDisable,
			RotateSecret:      caps.RotateSecret,
		},
	})
}
