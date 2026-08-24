package httpapi

import (
	"net/http"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/host"
)

// privilegesModePlaceholder is a literal placeholder for HostInfo's
// privileges_mode until the privileges Runner (Task 4, spec
// 01-host-matrix.md §Привилегии) lands and can report the real
// agent/direct/degraded mode. selfUpdateHint below documents the matching
// placeholder for caps.self_update.
const privilegesModePlaceholder = "direct"

// selfUpdateHint explains why caps.self_update is always false for now:
// the panel can't yet tell whether it holds the privileges a self-update
// needs (that's the same Runner work privilegesModePlaceholder is standing
// in for), so it reports the conservative answer rather than a capability
// that might not actually work.
const selfUpdateHint = "self-update capability detection is not implemented yet"

// hostCaps mirrors openapi HostInfo.caps.
type hostCaps struct {
	RestartTelemt bool `json:"restart_telemt"`
	RestartPanel  bool `json:"restart_panel"`
	LogTail       bool `json:"log_tail"`
	LogStream     bool `json:"log_stream"`
	SelfUpdate    bool `json:"self_update"`
}

// hostInfo mirrors openapi HostInfo.
type hostInfo struct {
	ServiceManager string            `json:"service_manager"`
	LogSource      string            `json:"log_source"`
	PrivilegesMode string            `json:"privileges_mode"`
	Caps           hostCaps          `json:"caps"`
	ManualCommands map[string]string `json:"manual_commands,omitempty"`
}

// handleHost implements GET /api/host: detected platform kinds, the
// (placeholder, see above) privileges mode, capability booleans, and
// copyable manual commands for every capability that's false — the UI
// rule (01-host-matrix.md) is that an unavailable operation is shown
// disabled with its manual command, never hidden.
func (s *Server) handleHost(w http.ResponseWriter, r *http.Request) {
	restartCaps := s.svcMgr.Caps()
	logCaps := s.logSrc.Caps()

	manual := map[string]string{}
	if !restartCaps.CanRestart {
		manual["restart_telemt"] = restartCaps.ManualRestartHint
		manual["restart_panel"] = restartCaps.ManualRestartHint
	}
	if !logCaps.CanTail {
		manual["log_tail"] = noLogSourceHint
	}
	if !logCaps.CanStream {
		manual["log_stream"] = noLogSourceHint
	}
	manual["self_update"] = selfUpdateHint

	writeJSON(w, http.StatusOK, hostInfo{
		ServiceManager: s.svcMgr.Kind(),
		LogSource:      s.logSrc.Kind(),
		PrivilegesMode: privilegesModePlaceholder,
		Caps: hostCaps{
			RestartTelemt: restartCaps.CanRestart,
			RestartPanel:  restartCaps.CanRestart,
			LogTail:       logCaps.CanTail,
			LogStream:     logCaps.CanStream,
			SelfUpdate:    false,
		},
		ManualCommands: manual,
	})
}

// noLogSourceHint is shown when no usable log source was detected or
// configured (LogCaps.CanTail/CanStream false) — mirroring
// host.None.Caps().ManualRestartHint's phrasing for the equivalent
// service-manager case.
const noLogSourceHint = "no log source detected or configured on this host; check the service's logs manually"

// resolveLogicalService maps the API's logical `service` query value
// (telemt|panel) to the actual unit/container name to pass into a host
// ServiceManager/LogSource call. Docker needs a container name instead of
// a systemd-style unit for telemt (see Docker/DockerLog's doc comments);
// there's no separate configured container name for the panel itself, so
// it always resolves to host.panel_service regardless of kind.
func resolveLogicalService(logical string, kind string, cfg config.HostConfig) (name string, ok bool) {
	switch logical {
	case "telemt":
		if kind == host.KindDocker {
			return cfg.TelemtContainer, true
		}
		return cfg.TelemtService, true
	case "panel":
		return cfg.PanelService, true
	default:
		return "", false
	}
}
