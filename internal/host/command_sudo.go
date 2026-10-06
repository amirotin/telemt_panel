package host

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/amirotin/telemt_panel/internal/atomicfile"
)

// CommandSudoRunner installs executables through the installer's exact sudoers
// commands. Files are opened by the service user and streamed to install; no
// privileged helper executable or source pathname is used.
type CommandSudoRunner struct {
	base      *SudoRunner
	stdinRun  StdinCmdRunner
	syncPath  func(string) error
	checkOnly bool
}

// NewCommandSudoRunner builds the independent worker's command transport.
// run and stdinRun must be wrapped with NewSudoCmdRunner and
// NewSudoStdinCmdRunner respectively. Service managers use the same wrapped run.
func NewCommandSudoRunner(allow AllowLists, svcMgr ServiceManager, logSrc LogSource, run CmdRunner, stdinRun StdinCmdRunner) *CommandSudoRunner {
	return &CommandSudoRunner{base: NewSudoRunner(allow, svcMgr, logSrc, run), stdinRun: stdinRun, syncPath: syncExecutablePath}
}

// NewCommandSudoPolicyRunner checks the exact command policy without opening
// sources or changing files. run and svcMgr must use NewSudoPolicyCmdRunner.
func NewCommandSudoPolicyRunner(allow AllowLists, svcMgr ServiceManager, logSrc LogSource, run CmdRunner) *CommandSudoRunner {
	return &CommandSudoRunner{base: NewSudoRunner(allow, svcMgr, logSrc, run), checkOnly: true}
}

// Run implements Runner with the same path and service allowlists as direct
// execution. Cleanup is limited to fixed artifacts of managed binaries.
func (r *CommandSudoRunner) Run(ctx context.Context, op Op) (Output, error) {
	switch op.Kind {
	case OpInstallBinary:
		source, err := requireWithinPrefix(op, ArgStaging, r.base.allow.StagingPrefix)
		if err != nil {
			return Output{}, err
		}
		dest, err := requireAllowedPath(op, ArgDest, r.base.allow.BinaryPaths)
		if err != nil {
			return Output{}, err
		}
		return Output{}, r.installExecutable(ctx, source, dest)
	case OpRestoreBinary:
		source, err := requireAllowedPath(op, ArgBackup, r.base.allow.BinaryPaths)
		if err != nil {
			return Output{}, err
		}
		dest, err := requireAllowedPath(op, ArgDest, r.base.allow.BinaryPaths)
		if err != nil {
			return Output{}, err
		}
		if source != dest+".bak" {
			return Output{}, fmt.Errorf("host: %s: backup %q does not belong to destination %q", op.Kind, source, dest)
		}
		return Output{}, r.installExecutable(ctx, source, dest)
	case OpRemoveBinary:
		path, err := requireUpdateArtifact(op, r.base.allow)
		if err != nil {
			return Output{}, err
		}
		return Output{}, runSudoStep(ctx, r.base.run, "rm", "-f", path)
	default:
		return r.base.Run(ctx, op)
	}
}

func (r *CommandSudoRunner) installExecutable(ctx context.Context, source, dest string) (err error) {
	tmp := dest + ".tmp"
	args := []string{"-m", "0755", "/dev/stdin", tmp}
	if r.checkOnly {
		if err := runSudoStep(ctx, r.base.run, "install", args...); err != nil {
			return err
		}
		return runSudoStep(ctx, r.base.run, "mv", "-f", tmp, dest)
	}
	if r.stdinRun == nil || r.base.run == nil {
		return errors.New("sudo command transport is not configured")
	}
	f, err := os.OpenFile(source, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return fmt.Errorf("host: open %q: %w", source, err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return fmt.Errorf("host: stat %q: %w", source, err)
	}
	if !info.Mode().IsRegular() || info.Size() > MaxBinaryCopySize {
		return fmt.Errorf("host: source %q must be a regular binary of at most %d bytes", source, MaxBinaryCopySize)
	}
	defer func() {
		if err != nil {
			cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer cancel()
			if cleanupErr := runSudoStep(cleanupCtx, r.base.run, "rm", "-f", tmp); cleanupErr != nil {
				err = errors.Join(err, fmt.Errorf("cleanup temporary executable: %w", cleanupErr))
			}
		}
	}()
	input := &io.LimitedReader{R: f, N: MaxBinaryCopySize + 1}
	_, stderr, err := r.stdinRun(ctx, input, "install", args...)
	if err != nil {
		return fmt.Errorf("host: install executable: %s: %w", strings.TrimSpace(string(stderr)), err)
	}
	if input.N == 0 {
		return fmt.Errorf("binary exceeds copy limit of %d bytes", MaxBinaryCopySize)
	}
	if err := r.syncPath(tmp); err != nil {
		return fmt.Errorf("sync temporary executable: %w", err)
	}
	// The worker persists publication intent before entering this operation,
	// so any rename error causes recovery even if the rename already happened.
	if err := runSudoStep(ctx, r.base.run, "mv", "-f", tmp, dest); err != nil {
		return err
	}
	if err := r.syncPath(filepath.Dir(dest)); err != nil {
		return &atomicfile.PublicationError{Err: err}
	}
	return nil
}

func syncExecutablePath(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	return errors.Join(file.Sync(), file.Close())
}
