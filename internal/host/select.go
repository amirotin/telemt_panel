package host

import (
	"context"
	"net"
	"time"
)

// Privileges mode values (config `[privileges] mode`, and SelectRunner's
// mode argument). PrivilegesModeDegraded is never a config value — it's
// one of ResolveMode's three possible results, reported by GET /api/host
// when neither direct execution nor the agent socket is available.
const (
	PrivilegesModeAuto     = "auto"
	PrivilegesModeAgent    = "agent"
	PrivilegesModeDirect   = "direct"
	PrivilegesModeDegraded = "degraded"
)

// dialProbeTimeout bounds SelectRunner's one-shot connect-and-close probe
// of the agent socket, used only to decide agent-vs-degraded — short
// because an unreachable/nonexistent socket should fail fast rather than
// delay startup.
const dialProbeTimeout = 500 * time.Millisecond

// degradedRunner is the fallback Runner SelectRunner returns when
// privileged execution isn't available: every Run reports
// ErrPrivilegesUnavailable rather than the panel failing to start or a
// caller panicking on a nil Runner.
type degradedRunner struct{}

// Run implements Runner.
func (degradedRunner) Run(ctx context.Context, op Op) (Output, error) {
	return Output{}, ErrPrivilegesUnavailable
}

// SelectRunner picks the Runner implementation privileges.mode resolves
// to:
//
//   - "direct": always in-process, taken at face value even when euid != 0
//     (an operator's explicit choice; ops then simply fail with a
//     permission error at execution time rather than being second-guessed
//     here).
//   - "agent": always the panel-agent socket client when socketPath dials
//     successfully, degraded otherwise.
//   - "auto" (or ""): euid == 0 selects direct; otherwise the same dial
//     probe as "agent" decides agent vs. degraded.
//
// allow/svcMgr/logSrc are direct mode's dependencies (built by the
// caller from config-derived values — see AllowLists' doc comment); they
// are unused when the result is an agent or degraded Runner. SelectRunner
// never errors and never blocks startup — a missing or unreachable agent
// degrades a capability, it never stops the panel from starting.
func SelectRunner(mode string, socketPath string, euid int, allow AllowLists, svcMgr ServiceManager, logSrc LogSource) Runner {
	switch mode {
	case PrivilegesModeDirect:
		return NewDirectRunner(allow, svcMgr, logSrc)
	case PrivilegesModeAgent:
		if dialProbe(socketPath) {
			return NewAgentClient(socketPath, defaultAgentOpTimeout)
		}
		return degradedRunner{}
	default: // PrivilegesModeAuto and unrecognized values alike
		if euid == 0 {
			return NewDirectRunner(allow, svcMgr, logSrc)
		}
		if dialProbe(socketPath) {
			return NewAgentClient(socketPath, defaultAgentOpTimeout)
		}
		return degradedRunner{}
	}
}

// ResolveMode reports which Runner kind SelectRunner would return for the
// same mode/socketPath/euid — "direct", "agent", or "degraded" — for
// callers (GET /api/host's privileges_mode) that need to display the mode
// without holding a second Runner instance around just to inspect its
// type. Mirrors SelectRunner's branching exactly, including reusing the
// same dialProbe; kept as a separate function rather than changing
// SelectRunner's signature so every existing caller keeps working
// unchanged.
func ResolveMode(mode string, socketPath string, euid int) string {
	switch mode {
	case PrivilegesModeDirect:
		return PrivilegesModeDirect
	case PrivilegesModeAgent:
		if dialProbe(socketPath) {
			return PrivilegesModeAgent
		}
		return PrivilegesModeDegraded
	default: // PrivilegesModeAuto and unrecognized values alike
		if euid == 0 {
			return PrivilegesModeDirect
		}
		if dialProbe(socketPath) {
			return PrivilegesModeAgent
		}
		return PrivilegesModeDegraded
	}
}

// dialProbe reports whether socketPath is a live, connectable unix
// socket, closing the connection immediately — SelectRunner only needs to
// know an agent is listening, not to keep the connection.
func dialProbe(socketPath string) bool {
	if socketPath == "" {
		return false
	}
	conn, err := net.DialTimeout("unix", socketPath, dialProbeTimeout)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}
