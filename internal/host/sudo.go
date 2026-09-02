package host

import (
	"context"
	"fmt"
	"strings"
)

// SudoRunner executes the same validated host operations as directRunner,
// but sends filesystem writes and service restarts through non-interactive
// sudo. One instance is shared by every update target on the host.
type SudoRunner struct {
	allow  AllowLists
	svcMgr ServiceManager
	logSrc LogSource
	run    CmdRunner
}

// NewSudoRunner builds a sudo-backed Runner. run must already wrap the
// underlying command runner with NewSudoCmdRunner (or the policy-checking
// equivalent used by ProbeRunner).
func NewSudoRunner(allow AllowLists, svcMgr ServiceManager, logSrc LogSource, run CmdRunner) *SudoRunner {
	return &SudoRunner{allow: allow, svcMgr: svcMgr, logSrc: logSrc, run: run}
}

// Run implements Runner. Binary replacement remains atomic: the privileged
// copy is written to a fixed sibling, chmodded, and only then renamed over the
// destination. All user-controlled paths and service names are validated by
// the same helpers ExecOp uses before a command is spawned.
func (r *SudoRunner) Run(ctx context.Context, op Op) (Output, error) {
	switch op.Kind {
	case OpInstallBinary:
		src, err := requireWithinPrefix(op, ArgStaging, r.allow.StagingPrefix)
		if err != nil {
			return Output{}, err
		}
		dest, err := requireAllowedPath(op, ArgDest, r.allow.BinaryPaths)
		if err != nil {
			return Output{}, err
		}
		return Output{}, r.installExecutable(ctx, src, dest)

	case OpRestoreBinary:
		src, err := requireAllowedPath(op, ArgBackup, r.allow.BinaryPaths)
		if err != nil {
			return Output{}, err
		}
		dest, err := requireAllowedPath(op, ArgDest, r.allow.BinaryPaths)
		if err != nil {
			return Output{}, err
		}
		return Output{}, r.installExecutable(ctx, src, dest)

	case OpRestartService:
		service, err := requireAllowedService(op, r.allow.Services)
		if err != nil {
			return Output{}, err
		}
		if r.svcMgr == nil {
			return Output{}, fmt.Errorf("host: %s: no service manager configured", op.Kind)
		}
		return Output{}, r.svcMgr.Restart(ctx, service)

	case OpReadJournal:
		service, err := requireAllowedService(op, r.allow.Services)
		if err != nil {
			return Output{}, err
		}
		lines, err := requireBoundedLines(op)
		if err != nil {
			return Output{}, err
		}
		if r.logSrc == nil {
			return Output{}, fmt.Errorf("host: %s: no log source configured", op.Kind)
		}
		logLines, err := r.logSrc.Tail(ctx, service, lines)
		if err != nil {
			return Output{}, err
		}
		return Output{Stdout: formatLogLines(logLines)}, nil

	case OpWriteConfig:
		return Output{}, fmt.Errorf("host: %s is not supported by sudo mode; use the Telemt config API", op.Kind)

	default:
		return Output{}, fmt.Errorf("host: unknown op kind %q", op.Kind)
	}
}

func (r *SudoRunner) installExecutable(ctx context.Context, src, dest string) error {
	tmp := dest + ".tmp"
	if err := runSudoStep(ctx, r.run, "cp", "-f", src, tmp); err != nil {
		return fmt.Errorf("copy executable to temporary path: %w", err)
	}
	if err := runSudoStep(ctx, r.run, "chmod", "0755", tmp); err != nil {
		return fmt.Errorf("chmod temporary executable: %w", err)
	}
	if err := runSudoStep(ctx, r.run, "mv", "-f", tmp, dest); err != nil {
		return fmt.Errorf("replace executable: %w", err)
	}
	return nil
}

func runSudoStep(ctx context.Context, run CmdRunner, name string, args ...string) error {
	if run == nil {
		return fmt.Errorf("sudo command runner is not configured")
	}
	_, stderr, err := run(ctx, name, args...)
	if err == nil {
		return nil
	}
	detail := strings.TrimSpace(string(stderr))
	if detail == "" {
		return fmt.Errorf("%s: %w", name, err)
	}
	return fmt.Errorf("%s: %s: %w", name, detail, err)
}

// NewSudoCmdRunner wraps every command as `sudo -n -- <command> ...`.
// There is deliberately no shell involved, so validated args cannot be
// reinterpreted as shell syntax.
func NewSudoCmdRunner(base CmdRunner) CmdRunner {
	return func(ctx context.Context, name string, args ...string) ([]byte, []byte, error) {
		sudoArgs := make([]string, 0, len(args)+3)
		sudoArgs = append(sudoArgs, "-n", "--", name)
		sudoArgs = append(sudoArgs, args...)
		return base(ctx, "sudo", sudoArgs...)
	}
}

// NewSudoPolicyCmdRunner checks whether sudoers permits a command without
// executing it. It has the same CmdRunner shape as NewSudoCmdRunner, so the
// real SudoRunner and real ServiceManager generate the exact argv being
// checked rather than maintaining a second command matrix.
func NewSudoPolicyCmdRunner(base CmdRunner) CmdRunner {
	return func(ctx context.Context, name string, args ...string) ([]byte, []byte, error) {
		sudoArgs := make([]string, 0, len(args)+4)
		sudoArgs = append(sudoArgs, "-n", "-l", "--", name)
		sudoArgs = append(sudoArgs, args...)
		return base(ctx, "sudo", sudoArgs...)
	}
}

// ProbeRunner verifies the complete set of operations needed by both update
// targets. With a SudoRunner wired to NewSudoPolicyCmdRunner this is read-only:
// sudo checks policy for the exact commands but executes none of them.
func ProbeRunner(ctx context.Context, runner Runner, ops []Op) bool {
	if runner == nil {
		return false
	}
	for _, op := range ops {
		if _, err := runner.Run(ctx, op); err != nil {
			return false
		}
	}
	return true
}
