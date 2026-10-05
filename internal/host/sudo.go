package host

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"

	"github.com/amirotin/telemt_panel/internal/atomicfile"
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
	case OpStartService, OpStopService:
		return execServiceControl(ctx, op, r.allow, r.svcMgr)
	case OpInstallBinary:
		src, err := requireWithinPrefix(op, ArgStaging, r.allow.StagingPrefix)
		if err != nil {
			return Output{}, err
		}
		dest, err := requireAllowedPath(op, ArgDest, r.allow.BinaryPaths)
		if err != nil {
			return Output{}, err
		}
		return Output{}, r.installExecutable(ctx, src, dest, false)

	case OpRestoreBinary:
		src, err := requireAllowedPath(op, ArgBackup, r.allow.BinaryPaths)
		if err != nil {
			return Output{}, err
		}
		dest, err := requireAllowedPath(op, ArgDest, r.allow.BinaryPaths)
		if err != nil {
			return Output{}, err
		}
		return Output{}, r.installExecutable(ctx, src, dest, true)

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

	default:
		return Output{}, fmt.Errorf("host: unknown op kind %q", op.Kind)
	}
}

func (r *SudoRunner) installExecutable(ctx context.Context, src, dest string, restore bool) error {
	for _, target := range []string{"panel", "telemt"} {
		binary := r.allow.TargetBinaries[target]
		if binary == "" {
			continue
		}
		operation := "install"
		expected := filepath.Join(r.allow.StagingPrefix, "runs", target, "bin")
		if restore {
			operation = "restore"
			expected = binary + ".bak"
		} else if dest == binary+".bak" {
			operation = "backup"
			expected = filepath.Join(r.allow.StagingPrefix, "runs", target, "backup")
		}
		if (dest == binary || (!restore && dest == binary+".bak")) && src == expected {
			helper, policy, err := helperPaths(r.allow)
			if err != nil {
				return err
			}
			err = runSudoStep(ctx, r.run, helper, "privileged", "--policy", policy, operation, target)
			var exit *ExitError
			if errors.As(err, &exit) && exit.Code == 2 {
				return &atomicfile.PublicationError{Err: err}
			}
			return err
		}
	}
	return errors.New("binary operation does not match a fixed privileged helper target")
}

func helperPaths(allow AllowLists) (string, string, error) {
	helper, policy := allow.HelperPath, allow.PolicyPath
	if helper == "" {
		helper = allow.TargetBinaries["panel"]
	}
	if policy == "" {
		policy = DefaultPrivilegedPolicyPath
	}
	if err := privilegedPath(helper); err != nil {
		return "", "", err
	}
	if err := privilegedPath(policy); err != nil {
		return "", "", err
	}
	if helper != allow.TargetBinaries["panel"] {
		return "", "", errors.New("privileged helper must use the configured panel binary")
	}
	return helper, policy, nil
}

// CheckPrivilegedPolicy executes only readonly inspect and checks runtime bindings.
func CheckPrivilegedPolicy(ctx context.Context, allow AllowLists, run CmdRunner) error {
	helper, path, err := helperPaths(allow)
	if err != nil {
		return err
	}
	if run == nil {
		return errors.New("privileged policy inspect runner is unavailable")
	}
	stdout, stderr, err := run(ctx, helper, "privileged", "--policy", path, "inspect")
	if err != nil {
		return fmt.Errorf("privileged policy inspect: %s: %w", strings.TrimSpace(string(stderr)), err)
	}
	if len(stdout) > maxPolicySize {
		return errors.New("privileged policy inspection exceeds 64 KiB")
	}
	var policy PrivilegedPolicy
	decoder := json.NewDecoder(strings.NewReader(string(stdout)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&policy); err != nil {
		return fmt.Errorf("decode privileged policy inspection: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("privileged policy inspection has trailing JSON")
	}
	if policy.Version != 1 || len(policy.Binaries) != 2 || policy.StagingRoot != filepath.Clean(allow.StagingPrefix) || policy.Binaries["panel"] != allow.TargetBinaries["panel"] || policy.Binaries["telemt"] != allow.TargetBinaries["telemt"] {
		return errors.New("privileged policy differs from runtime paths; repair the panel installation")
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
