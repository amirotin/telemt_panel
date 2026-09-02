package httpapi

import (
	"bufio"
	"net/http"
	"os"
	"runtime"
	"strings"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/host"
)

// selfUpdateHint explains why caps.self_update is false: the panel's
// Runner is manual (host selection found no complete privilege path),
// so it can't actually install either binary no matter what the update engine
// otherwise supports.
const selfUpdateHint = "binary updates are unavailable because the installation privileges are incomplete; repair the panel installation or run it as root"

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
	OS             string            `json:"os"`
	Arch           string            `json:"arch"`
	OSRelease      string            `json:"os_release,omitempty"`
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
	// privilegedOps reflects whether the Runner can execute privileged ops
	// at all, not whether an update is actually available right now (that's
	// GET /api/updates' job) — a manual Runner makes Apply fail cleanly
	// regardless of what releases exist, so it's the correct false case
	// here.
	privilegedOps := s.privilegesMode != host.PrivilegesModeManual
	restartAvailable := restartCaps.CanRestart && privilegedOps

	manual := map[string]string{}
	if !restartAvailable {
		telemtHint := restartCaps.ManualRestartHint
		panelHint := restartCaps.ManualRestartHint
		if restartCaps.CanRestart {
			telemtName, _ := resolveLogicalService("telemt", s.svcMgr.Kind(), s.cfg.Host)
			panelName, _ := resolveLogicalService("panel", s.svcMgr.Kind(), s.cfg.Host)
			telemtHint = manualRestartCommand(s.svcMgr.Kind(), telemtName)
			panelHint = manualRestartCommand(s.svcMgr.Kind(), panelName)
		}
		manual["restart_telemt"] = telemtHint
		manual["restart_panel"] = panelHint
	}
	if !logCaps.CanTail {
		manual["log_tail"] = noLogSourceHint
	}
	if !logCaps.CanStream {
		manual["log_stream"] = noLogSourceHint
	}
	if !privilegedOps {
		manual["self_update"] = selfUpdateHint
	}

	writeJSON(w, http.StatusOK, hostInfo{
		ServiceManager: s.svcMgr.Kind(),
		LogSource:      s.logSrc.Kind(),
		PrivilegesMode: s.privilegesMode,
		OS:             runtime.GOOS,
		Arch:           runtime.GOARCH,
		OSRelease:      detectOSRelease(),
		Caps: hostCaps{
			RestartTelemt: restartAvailable,
			RestartPanel:  restartAvailable,
			LogTail:       logCaps.CanTail,
			LogStream:     logCaps.CanStream,
			SelfUpdate:    privilegedOps,
		},
		ManualCommands: manual,
	})
}

func manualRestartCommand(kind, service string) string {
	if service == "" {
		return "restart the service manually as an administrator"
	}
	arg := shellCommandArg(service)
	switch kind {
	case host.KindSystemd:
		return "systemctl restart " + arg
	case host.KindOpenRC:
		return "rc-service " + arg + " restart"
	case host.KindProcd, host.KindSysvinit:
		return shellCommandArg("/etc/init.d/"+service) + " restart"
	case host.KindDocker:
		return "docker restart " + arg
	default:
		return "restart the service manually as an administrator"
	}
}

func shellCommandArg(value string) string {
	if value != "" && strings.IndexFunc(value, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("._@:/-", r))
	}) == -1 {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func detectOSRelease() string {
	for _, path := range []string{"/etc/os-release", "/usr/lib/os-release", "/etc/openwrt_release"} {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		if release := parseOSRelease(data); release != "" {
			return release
		}
	}
	return ""
}

func parseOSRelease(data []byte) string {
	values := map[string]string{}
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		values[key] = strings.Trim(strings.TrimSpace(value), "\"'")
	}
	for _, key := range []string{"PRETTY_NAME", "DISTRIB_DESCRIPTION", "NAME"} {
		if value := strings.TrimSpace(values[key]); value != "" {
			return value
		}
	}
	return ""
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
