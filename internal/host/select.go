package host

import (
	"context"
)

// Privileges mode values (config `[privileges] mode`, and SelectRunner's
// mode argument). Legacy 0.x sudoers is an internal compatibility backend
// reported as "sudo"; users only need to distinguish direct, sudo and manual.
const (
	PrivilegesModeAuto   = "auto"
	PrivilegesModeDirect = "direct"
	PrivilegesModeSudo   = "sudo"
	PrivilegesModeManual = "manual"
)

// RunnerSelectionOptions contains the one host-wide privilege decision.
// SudoRunner/SudoAvailable describe a fully probed sudo policy for both
// update targets; they are never selected independently per target.
type RunnerSelectionOptions struct {
	Mode           string
	EUID           int
	Allow          AllowLists
	ServiceManager ServiceManager
	LogSource      LogSource
	SudoRunner     Runner
	SudoAvailable  bool
}

// manualRunner is the fallback Runner SelectRunner returns when
// privileged execution isn't available: every Run reports
// ErrPrivilegesUnavailable rather than the panel failing to start or a
// caller panicking on a nil Runner.
type manualRunner struct{}

// Run implements Runner.
func (manualRunner) Run(ctx context.Context, op Op) (Output, error) {
	return Output{}, ErrPrivilegesUnavailable
}

// SelectRunner selects one Runner and reports the same resolved mode
// in one pass. Auto mode prefers direct execution for root, then a completely
// validated sudo policy, and otherwise exposes manual operations.
func SelectRunner(opts RunnerSelectionOptions) (Runner, string) {
	switch opts.Mode {
	case PrivilegesModeDirect:
		return NewDirectRunner(opts.Allow, opts.ServiceManager, opts.LogSource), PrivilegesModeDirect
	case PrivilegesModeSudo:
		if opts.SudoAvailable && opts.SudoRunner != nil {
			return opts.SudoRunner, PrivilegesModeSudo
		}
		return manualRunner{}, PrivilegesModeManual
	case PrivilegesModeManual:
		return manualRunner{}, PrivilegesModeManual
	default: // PrivilegesModeAuto and unrecognized values alike
		if opts.EUID == 0 {
			return NewDirectRunner(opts.Allow, opts.ServiceManager, opts.LogSource), PrivilegesModeDirect
		}
		if opts.SudoAvailable && opts.SudoRunner != nil {
			return opts.SudoRunner, PrivilegesModeSudo
		}
		return manualRunner{}, PrivilegesModeManual
	}
}
