package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/update"
)

type serviceControlCaps struct {
	Start   bool `json:"start"`
	Stop    bool `json:"stop"`
	Restart bool `json:"restart"`
}

func serviceBindingsDiffer(kind, telemtName, panelName string) bool {
	if telemtName == "" {
		return false
	}
	if kind == host.KindSystemd {
		telemtName = strings.TrimSuffix(telemtName, ".service")
		panelName = strings.TrimSuffix(panelName, ".service")
	}
	return telemtName != panelName
}

func (s *Server) serviceCaps() serviceControlCaps {
	caps := serviceControlCaps{Restart: s.svcMgr.Caps().CanRestart && s.privilegesMode != host.PrivilegesModeManual}
	panelName, _ := resolveLogicalService("panel", s.svcMgr.Kind(), s.cfg.Host)
	if !serviceBindingsDiffer(s.svcMgr.Kind(), s.telemtServiceName, panelName) {
		return caps
	}
	if _, ok := s.svcMgr.(host.ServiceController); !ok {
		return caps
	}
	switch s.privilegesMode {
	case host.PrivilegesModeDirect:
		caps.Start = true
		caps.Stop = true
	case host.PrivilegesModeSudo:
		caps.Start = s.serviceStartAllowed
		caps.Stop = s.serviceStopAllowed
	}
	return caps
}

func manualServiceCommand(kind, service, action string) string {
	if service == "" {
		return ""
	}
	arg := shellCommandArg(service)
	switch kind {
	case host.KindSystemd:
		return "systemctl " + action + " " + arg
	case host.KindOpenRC:
		return "rc-service " + arg + " " + action
	case host.KindProcd, host.KindSysvinit:
		return shellCommandArg("/etc/init.d/"+service) + " " + action
	case host.KindDocker:
		return "docker " + action + " " + arg
	default:
		return ""
	}
}

func serviceCommandHint(manager host.ServiceManager, service, action string) string {
	if custom, ok := manager.(interface{ Command(string, string) []string }); ok {
		argv := custom.Command(service, action)
		quoted := make([]string, len(argv))
		for i, arg := range argv {
			quoted[i] = shellCommandArg(arg)
		}
		return strings.Join(quoted, " ")
	}
	return manualServiceCommand(manager.Kind(), service, action)
}

func (s *Server) handleTelemtService(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	status := host.StatusUnknown
	statusError := ""
	nativeState := ""
	supported := s.svcMgr.Caps().CanStatus
	if supported {
		var value host.ServiceStatus
		var err error
		if detailer, ok := s.svcMgr.(host.ServiceStateDetailer); ok {
			nativeState, err = detailer.DetailedState(ctx, s.telemtServiceName)
			switch nativeState {
			case "active":
				value = host.StatusRunning
			case "inactive", "failed":
				value = host.StatusStopped
			default:
				value = host.StatusUnknown
			}
		} else {
			value, err = s.svcMgr.Status(ctx, s.telemtServiceName)
		}
		if err != nil {
			statusError = "service_status_unavailable"
			nativeState = ""
		} else if value == host.StatusRunning || value == host.StatusStopped {
			status = value
		}
	}
	panelName, _ := resolveLogicalService("panel", s.svcMgr.Kind(), s.cfg.Host)
	conflict := s.telemtServiceName != "" && !serviceBindingsDiffer(s.svcMgr.Kind(), s.telemtServiceName, panelName)
	caps := s.serviceCaps()
	manual := map[string]string{}
	for action, enabled := range map[string]bool{"start": caps.Start, "stop": caps.Stop, "restart": caps.Restart} {
		if !enabled && (!conflict || action == "restart") {
			if command := serviceCommandHint(s.svcMgr, s.telemtServiceName, action); command != "" {
				manual[action] = command
			}
		}
	}
	writeJSON(w, 200, struct {
		Service         string             `json:"service"`
		Manager         string             `json:"manager"`
		Status          host.ServiceStatus `json:"status"`
		NativeState     string             `json:"native_state,omitempty"`
		StatusSupported bool               `json:"status_supported"`
		StatusError     string             `json:"status_error,omitempty"`
		BindingConflict bool               `json:"binding_conflict"`
		Caps            serviceControlCaps `json:"caps"`
		Manual          map[string]string  `json:"manual_commands"`
		Busy            bool               `json:"busy"`
	}{s.telemtServiceName, s.svcMgr.Kind(), status, nativeState, supported, statusError, conflict, caps, manual, s.updateEngine.LockHeld()})
}

func (s *Server) handleTelemtStart(w http.ResponseWriter, r *http.Request) {
	s.handleServiceAction(w, r, "start")
}
func (s *Server) handleTelemtStop(w http.ResponseWriter, r *http.Request) {
	s.handleServiceAction(w, r, "stop")
}

func (s *Server) handleServiceAction(w http.ResponseWriter, r *http.Request, action string) {
	caps := s.serviceCaps()
	enabled := caps.Restart
	kind := host.OpRestartService
	if action == "start" {
		enabled = caps.Start
		kind = host.OpStartService
	} else if action == "stop" {
		enabled = caps.Stop
		kind = host.OpStopService
	}
	if !enabled {
		code := "manual_service_control_required"
		message := "automatic service control is unavailable; check the configured binding and exact host permissions"
		if action == "restart" {
			code = "manual_restart_required"
			hint := s.svcMgr.Caps().ManualRestartHint
			if s.svcMgr.Caps().CanRestart {
				hint = serviceCommandHint(s.svcMgr, s.telemtServiceName, "restart")
			}
			message += ": " + hint
		}
		auth.WriteError(w, 503, code, message)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	err := s.updateEngine.WithHostControl(func() error {
		_, err := s.runner.Run(ctx, host.Op{Kind: kind, Args: map[string]string{host.ArgService: s.telemtServiceName}})
		return err
	})
	if errors.Is(err, update.ErrBusy) {
		auth.WriteError(w, 409, "update_locked", "another host operation is in progress")
		return
	}
	if err != nil {
		slog.Warn("service control result unconfirmed", "action", action, "err", err)
		s.appendAudit(r, "telemt."+action+".unconfirmed", "", "")
		auth.WriteError(w, 502, "service_action_unconfirmed", "service command result is unconfirmed; check service state before retrying")
		return
	}
	s.appendAudit(r, "telemt."+action, "", "")
	w.WriteHeader(http.StatusAccepted)
}
