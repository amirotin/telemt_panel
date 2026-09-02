package host

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// LegacySudoRunner adapts the current Runner contract to the exact staging
// and temporary paths provisioned by the 0.x systemd installer. It is a
// migration bridge only: new installations should use SudoRunner's policy.
type LegacySudoRunner struct {
	allow     AllowLists
	svcMgr    ServiceManager
	logSrc    LogSource
	run       CmdRunner
	checkOnly bool
}

// NewLegacySudoRunner builds the 0.x sudoers compatibility transport.
func NewLegacySudoRunner(allow AllowLists, svcMgr ServiceManager, logSrc LogSource, run CmdRunner) *LegacySudoRunner {
	return &LegacySudoRunner{allow: allow, svcMgr: svcMgr, logSrc: logSrc, run: run}
}

// NewLegacySudoPolicyRunner builds a read-only policy checker for the exact
// commands LegacySudoRunner would execute. Local staging copies are skipped.
func NewLegacySudoPolicyRunner(allow AllowLists, svcMgr ServiceManager, logSrc LogSource, run CmdRunner) *LegacySudoRunner {
	return &LegacySudoRunner{allow: allow, svcMgr: svcMgr, logSrc: logSrc, run: run, checkOnly: true}
}

// Run implements Runner using the 0.x installer's fixed command layout.
func (r *LegacySudoRunner) Run(ctx context.Context, op Op) (Output, error) {
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
		if strings.HasSuffix(dest, ".bak") {
			live := strings.TrimSuffix(dest, ".bak")
			if !pathAllowed(live, r.allow.BinaryPaths) {
				return Output{}, fmt.Errorf("host: %s: backup destination %q has no allowed live binary", op.Kind, dest)
			}
			return Output{}, runSudoStep(ctx, r.run, "cp", "-f", live, r.legacyBackupPath(live))
		}
		return Output{}, r.installFrom(ctx, src, dest)

	case OpRestoreBinary:
		backup, err := requireAllowedPath(op, ArgBackup, r.allow.BinaryPaths)
		if err != nil {
			return Output{}, err
		}
		dest, err := requireAllowedPath(op, ArgDest, r.allow.BinaryPaths)
		if err != nil {
			return Output{}, err
		}
		if backup != dest+".bak" {
			return Output{}, fmt.Errorf("host: %s: backup %q does not belong to destination %q", op.Kind, backup, dest)
		}
		return Output{}, r.installFrom(ctx, r.legacyBackupPath(dest), dest)

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
		return Output{}, fmt.Errorf("host: %s is not supported by legacy sudo mode; use the Telemt config API", op.Kind)

	default:
		return Output{}, fmt.Errorf("host: unknown op kind %q", op.Kind)
	}
}

func (r *LegacySudoRunner) installFrom(ctx context.Context, src, dest string) error {
	legacySource := filepath.Join(r.allow.StagingPrefix, filepath.Base(dest))
	if !r.checkOnly {
		if err := installExecutable(src, legacySource); err != nil {
			return fmt.Errorf("stage executable for legacy sudoers: %w", err)
		}
		defer os.Remove(legacySource)
	}

	tmp := filepath.Join(filepath.Dir(dest), "."+filepath.Base(dest)+".tmp")
	defer func() {
		_ = runSudoStep(ctx, r.run, "rm", "-f", tmp)
	}()
	if err := runSudoStep(ctx, r.run, "cp", "-f", legacySource, tmp); err != nil {
		return fmt.Errorf("copy executable to legacy temporary path: %w", err)
	}
	if err := runSudoStep(ctx, r.run, "chmod", "0755", tmp); err != nil {
		return fmt.Errorf("chmod legacy temporary executable: %w", err)
	}
	if err := runSudoStep(ctx, r.run, "mv", "-f", tmp, dest); err != nil {
		return fmt.Errorf("replace executable through legacy sudoers: %w", err)
	}
	return nil
}

func (r *LegacySudoRunner) legacyBackupPath(dest string) string {
	return filepath.Join(r.allow.StagingPrefix, filepath.Base(dest)+".bak")
}

func pathAllowed(path string, allow []string) bool {
	for _, candidate := range allow {
		if path == candidate {
			return true
		}
	}
	return false
}
