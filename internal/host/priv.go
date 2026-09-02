package host

import (
	"context"
	"errors"
)

// Privileged operation kinds — the complete allow-list. No other kind is
// ever executed by a Runner.
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

// Op argument keys, shared between callers building an Op and every Runner's
// validation.
const (
	ArgStaging = "staging"
	ArgBackup  = "backup"
	ArgDest    = "dest"
	ArgService = "service"
	ArgLines   = "lines"
	ArgPath    = "path"
	ArgContent = "content"
)

// Op is one privileged operation request: a fixed kind plus its named
// string arguments. Every arg is validated against an allow-list on both
// direct and sudo execution paths before
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
// only thing in the panel process (or its privilege transport) allowed to
// touch protected binaries, config files, or services. Direct and sudo
// implementations share the same operation contract; a manual fallback keeps
// the panel readable when neither is available.
type Runner interface {
	Run(ctx context.Context, op Op) (Output, error)
}

// ErrPrivilegesUnavailable is returned by every Run call in manual mode. It
// is never fatal: callers surface false capabilities and manual instructions;
// SelectRunner itself never errors or blocks startup.
var ErrPrivilegesUnavailable = errors.New("host: privileges unavailable (repair the installation privileges or run the panel as root)")
