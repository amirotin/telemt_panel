package httpapi

import (
	"net/http"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/host"
)

// selfUpdateHint explains why caps.self_update is false: the panel's
// Runner is degraded (host.SelectRunner found neither direct execution nor
// a reachable panel-agent socket), so it can't actually install a binary
// no matter what the update engine otherwise supports.
const selfUpdateHint = "no privileges available to install a binary; run install.sh to install panel-agent, or run the panel as root"

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
// privileges mode, capability booleans, and copyable manual commands for
// every capability that's false — the UI rule (01-host-matrix.md) is that
// an unavailable operation is shown disabled with its manual command,
// never hidden.
func (s *Server) handleHost(w http.ResponseWriter, r *http.Request) {
	restartCaps := s.svcMgr.Caps()
	logCaps := s.logSrc.Caps()
	// self_update reflects whether the Runner can execute privileged ops at
	// all, not whether an update is actually available right now (that's
	// GET /api/updates' job) — a degraded Runner makes Apply fail cleanly
	// regardless of what releases exist, so it's the correct false case
	// here.
	selfUpdate := s.privilegesMode != host.PrivilegesModeDegraded

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
	if !selfUpdate {
		manual["self_update"] = selfUpdateHint
	}

	writeJSON(w, http.StatusOK, hostInfo{
		ServiceManager: s.svcMgr.Kind(),
		LogSource:      s.logSrc.Kind(),
		PrivilegesMode: s.privilegesMode,
		Caps: hostCaps{
			RestartTelemt: restartCaps.CanRestart,
			RestartPanel:  restartCaps.CanRestart,
			LogTail:       logCaps.CanTail,
			LogStream:     logCaps.CanStream,
			SelfUpdate:    selfUpdate,
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
// a systemd-style unit for both telemt and panel (see Docker/DockerLog's
// doc comments) — host.panel_container mirrors host.telemt_container so a
// dockerized panel doesn't resolve to a systemd-style unit name that means
// nothing to `docker restart`/`docker logs`.
func resolveLogicalService(logical string, kind string, cfg config.HostConfig) (name string, ok bool) {
	switch logical {
	case "telemt":
		if kind == host.KindDocker {
			return cfg.TelemtContainer, true
		}
		return cfg.TelemtService, true
	case "panel":
		if kind == host.KindDocker {
			return cfg.PanelContainer, true
		}
		return cfg.PanelService, true
	default:
		return "", false
	}
}
