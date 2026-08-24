package host

import (
	"context"
	"errors"
)

// Privileged operation kinds — the complete allow-list. No other kind is
// ever executed, on either the direct or agent Runner path (see
// ExecOp in privexec.go, the one place that switches on Kind).
const (
	// OpInstallBinary atomically installs a downloaded binary. Args:
	// "staging" (source file), "dest" (install path, must be allow-listed).
	OpInstallBinary = "install-binary"
	// OpRestoreBinary rolls a binary back to a saved backup. Args:
	// "backup" (source file, must be allow-listed), "dest" (install path,
	// must be allow-listed).
	OpRestoreBinary = "restore-binary"
	// OpRestartService restarts a managed service. Args: "service" (must
	// be allow-listed).
	OpRestartService = "restart-service"
	// OpReadJournal tails a service's log. Args: "service" (must be
	// allow-listed), "lines" (bounded positive integer, as a string).
	OpReadJournal = "read-journal"
	// OpWriteConfig rewrites a config file in place. Args: "path" (must be
	// allow-listed), "content" (the new file contents).
	OpWriteConfig = "write-config"
)

// Op argument keys, shared between callers building an Op, ExecOp's
// validation, and cmd/panel-agent's audit logging (which picks one "primary"
// key per kind to log, never "content").
const (
	ArgStaging = "staging"
	ArgBackup  = "backup"
	ArgDest    = "dest"
	ArgService = "service"
	ArgLines   = "lines"
	ArgPath    = "path"
	ArgContent = "content"
)

// DefaultAgentSocket is the panel-agent's default unix socket path,
// shared by the panel's config default and the agent binary's own flag
// default so the two can't drift apart.
const DefaultAgentSocket = "/run/telemt-panel/agent.sock"

// Op is one privileged operation request: a fixed kind plus its named
// string arguments. Every arg is validated against an allow-list on BOTH
// the direct and agent execution paths (ExecOp, in privexec.go) before
// it's ever used to touch the filesystem or spawn a service-manager
// command — callers must not assume validation happened upstream.
type Op struct {
	Kind string            `json:"kind"`
	Args map[string]string `json:"args"`
}

// Output is a privileged operation's result. Only restart-service and
// write-config carry no meaningful stdout; read-journal's is the
// formatted tail (see formatLogLines).
type Output struct {
	Stdout string `json:"stdout"`
}

// Runner is the single execution point for privileged operations — the
// only thing in the panel process (or the agent) allowed to touch
// protected binaries, config files, or services. Two implementations of
// this interface exist (direct.go, agent_client.go) plus a degraded
// fallback; SelectRunner picks between them at startup.
type Runner interface {
	Run(ctx context.Context, op Op) (Output, error)
}

// ErrPrivilegesUnavailable is returned by every Run call on the degraded
// Runner SelectRunner falls back to when neither direct execution
// (euid==0) nor the panel-agent socket is available. It is never fatal:
// callers surface it as a false capability with an actionable hint
// (install.sh sets up panel-agent, or the panel can be run as root) —
// per the milestone's "missing privileges must never break the panel"
// invariant, SelectRunner itself never errors or blocks startup.
var ErrPrivilegesUnavailable = errors.New("host: privileges unavailable (run install.sh to install panel-agent, or run the panel as root)")
