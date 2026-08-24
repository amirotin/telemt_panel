package host

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// maxJournalLines bounds OpReadJournal's "lines" argument. Generous for an
// operator-triggered diagnostic tail, small enough that a malformed or
// hostile value can't turn one op into an unbounded log dump.
const maxJournalLines = 10000

// AllowLists is the validation policy every op argument is checked
// against, on both the direct and agent execution paths — the single
// place service names and filesystem paths are decided to be safe to
// touch. On the agent, these come from its own --allow-binary-dest/
// --allow-config-path/--staging-prefix/--allow-service flags (its final
// authority regardless of what the client sends); in direct mode, the
// caller wiring SelectRunner constructs the equivalent lists from the
// panel's own config-derived values (the configured telemt/panel binary
// paths and service/container names).
//
// The three path fields are deliberately partitioned by purpose rather
// than one shared list: install-binary/restore-binary and write-config
// must never become mutually addressable (a client that can only write
// binaries must not be able to redirect that into overwriting a config
// file, and vice versa) once M3 adds a real write-config path — see
// ExecOp, which validates each op's path args against exactly one of
// these fields, never a union of them.
type AllowLists struct {
	// BinaryPaths lists the absolute paths install-binary's "dest" and
	// restore-binary's "dest"/"backup" may target.
	BinaryPaths []string
	// ConfigPaths lists the absolute paths write-config's "path" may
	// target. Kept separate from BinaryPaths (see the type doc comment).
	ConfigPaths []string
	// StagingPrefix is the one directory prefix install-binary's
	// "staging" source must fall under. Unlike BinaryPaths/ConfigPaths
	// this is a *prefix*, not an exact-match list: the panel's staging
	// path varies per update run (e.g. a fresh subdirectory per run), so
	// a fixed allow-list entry doesn't fit. Without this, an authorized
	// client could point "staging" at any absolute file the agent can
	// read and have it copied into an allow-listed dest — an
	// arbitrary-file-read primitive. Empty means no staging path
	// validates (install-binary is unusable), never "allow anything".
	StagingPrefix string
	// Services lists the service/container names restart-service and
	// read-journal may target.
	Services []string
}

// ExecOp validates op's arguments against allow and executes it,
// delegating restart-service to svcMgr and read-journal to logSrc. This
// is the one code path both direct.go's in-process Runner and
// cmd/panel-agent's connection handler call — the shared "op-execution"
// layer the milestone requires so the two can never drift in what they
// accept or how they run it. svcMgr/logSrc may be nil; restart-service/
// read-journal report a clear error rather than panicking when the
// matching one is nil (a caller with no privileged use for that
// interface, e.g. a config-only agent instance, need not wire it).
func ExecOp(ctx context.Context, op Op, allow AllowLists, svcMgr ServiceManager, logSrc LogSource) (Output, error) {
	switch op.Kind {
	case OpInstallBinary:
		staging, err := requireWithinPrefix(op, ArgStaging, allow.StagingPrefix)
		if err != nil {
			return Output{}, err
		}
		dest, err := requireAllowedPath(op, ArgDest, allow.BinaryPaths)
		if err != nil {
			return Output{}, err
		}
		return Output{}, installExecutable(staging, dest)

	case OpRestoreBinary:
		backup, err := requireAllowedPath(op, ArgBackup, allow.BinaryPaths)
		if err != nil {
			return Output{}, err
		}
		dest, err := requireAllowedPath(op, ArgDest, allow.BinaryPaths)
		if err != nil {
			return Output{}, err
		}
		return Output{}, installExecutable(backup, dest)

	case OpRestartService:
		service, err := requireAllowedService(op, allow.Services)
		if err != nil {
			return Output{}, err
		}
		if svcMgr == nil {
			return Output{}, fmt.Errorf("host: %s: no service manager configured", op.Kind)
		}
		return Output{}, svcMgr.Restart(ctx, service)

	case OpReadJournal:
		service, err := requireAllowedService(op, allow.Services)
		if err != nil {
			return Output{}, err
		}
		lines, err := requireBoundedLines(op)
		if err != nil {
			return Output{}, err
		}
		if logSrc == nil {
			return Output{}, fmt.Errorf("host: %s: no log source configured", op.Kind)
		}
		logLines, err := logSrc.Tail(ctx, service, lines)
		if err != nil {
			return Output{}, err
		}
		return Output{Stdout: formatLogLines(logLines)}, nil

	case OpWriteConfig:
		path, err := requireAllowedPath(op, ArgPath, allow.ConfigPaths)
		if err != nil {
			return Output{}, err
		}
		content, ok := op.Args[ArgContent]
		if !ok {
			return Output{}, fmt.Errorf("host: %s: missing required arg %q", op.Kind, ArgContent)
		}
		return Output{}, writeFileInPlace(path, content)

	default:
		return Output{}, fmt.Errorf("host: unknown op kind %q", op.Kind)
	}
}

// requireSourcePath reads a required path arg and checks it's absolute
// with no ".." traversal — the baseline every path arg gets, layered
// under either an allow-list membership check (requireAllowedPath) or a
// prefix check (requireWithinPrefix).
func requireSourcePath(op Op, key string) (string, error) {
	v, ok := op.Args[key]
	if !ok || v == "" {
		return "", fmt.Errorf("host: %s: missing required arg %q", op.Kind, key)
	}
	if err := validatePathShape(v); err != nil {
		return "", fmt.Errorf("host: %s: arg %q: %w", op.Kind, key, err)
	}
	return v, nil
}

// requireAllowedPath reads a required path arg, checks it's absolute with
// no ".." traversal, and requires it to be a member of allow — the check
// backing the carried obligation that dest/backup/config paths are never
// trusted from the request alone.
func requireAllowedPath(op Op, key string, allow []string) (string, error) {
	v, err := requireSourcePath(op, key)
	if err != nil {
		return "", err
	}
	for _, a := range allow {
		if v == a {
			return v, nil
		}
	}
	return "", fmt.Errorf("host: %s: arg %q value %q is not in the allowed path list", op.Kind, key, v)
}

// requireWithinPrefix reads a required path arg, checks it's absolute
// with no ".." traversal, and requires it to fall under prefix — the
// staging-path check backing FINDING 1's fix. The comparison is done on
// filepath.Clean'd forms and requires an exact match on prefix itself or
// a match on prefix+separator, so a sibling directory that merely shares
// prefix as a string prefix (e.g. prefix "/a/staging" and path
// "/a/staging-evil/x") is correctly rejected rather than accepted by a
// naive strings.HasPrefix(path, prefix) check. An empty prefix always
// rejects — there is no "no prefix configured means allow anything"
// fallback.
func requireWithinPrefix(op Op, key, prefix string) (string, error) {
	v, err := requireSourcePath(op, key)
	if err != nil {
		return "", err
	}
	if prefix == "" {
		return "", fmt.Errorf("host: %s: arg %q: no staging prefix configured", op.Kind, key)
	}
	cleanPrefix := filepath.Clean(prefix)
	cleanPath := filepath.Clean(v)
	if cleanPath != cleanPrefix && !strings.HasPrefix(cleanPath, cleanPrefix+string(os.PathSeparator)) {
		return "", fmt.Errorf("host: %s: arg %q value %q is outside the staging prefix %q", op.Kind, key, v, prefix)
	}
	return v, nil
}

// validatePathShape rejects a relative path or one containing a ".."
// segment, regardless of allow-list membership.
func validatePathShape(p string) error {
	if !filepath.IsAbs(p) {
		return fmt.Errorf("path %q must be absolute", p)
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." {
			return fmt.Errorf("path %q must not contain \"..\"", p)
		}
	}
	return nil
}

// requireAllowedService reads the required "service" arg, rejects one
// beginning with "-" (defense against it being read as a flag by
// whatever command line a ServiceManager builds from it), and requires
// allow-list membership.
func requireAllowedService(op Op, allow []string) (string, error) {
	v, ok := op.Args[ArgService]
	if !ok || v == "" {
		return "", fmt.Errorf("host: %s: missing required arg %q", op.Kind, ArgService)
	}
	if strings.HasPrefix(v, "-") {
		return "", fmt.Errorf("host: %s: service name %q must not begin with \"-\"", op.Kind, v)
	}
	for _, a := range allow {
		if v == a {
			return v, nil
		}
	}
	return "", fmt.Errorf("host: %s: service %q is not in the allowed service list", op.Kind, v)
}

// requireBoundedLines reads and parses the required "lines" arg,
// rejecting anything non-positive or over maxJournalLines.
func requireBoundedLines(op Op) (int, error) {
	v, ok := op.Args[ArgLines]
	if !ok || v == "" {
		return 0, fmt.Errorf("host: %s: missing required arg %q", op.Kind, ArgLines)
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("host: %s: arg %q value %q is not an integer", op.Kind, ArgLines, v)
	}
	if n <= 0 || n > maxJournalLines {
		return 0, fmt.Errorf("host: %s: arg %q value %d is out of range (1-%d)", op.Kind, ArgLines, n, maxJournalLines)
	}
	return n, nil
}

// installExecutable copies src's content onto dest atomically (temp file
// in dest's directory, then rename), forcing mode 0755 regardless of
// src's mode — an installed binary must be executable no matter what
// permissions the staged/backup copy happened to carry.
//
// src is opened with O_NOFOLLOW rather than read via os.ReadFile: the
// staging path is only prefix-validated as a string (requireWithinPrefix),
// so a symlink planted inside the staging dir and pointing outside it
// would otherwise be followed transparently, letting an op that's only
// supposed to read from staging read (and then install) an arbitrary file
// the process can access. O_NOFOLLOW makes the open fail on a symlink
// final component instead of following it.
func installExecutable(src, dest string) error {
	f, err := os.OpenFile(src, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return fmt.Errorf("host: open %q: %w", src, err)
	}
	defer f.Close()
	data, err := io.ReadAll(f)
	if err != nil {
		return fmt.Errorf("host: read %q: %w", src, err)
	}
	return atomicWrite(dest, data, 0o755)
}

// atomicWrite writes data to a temp file in dest's directory, syncs it,
// then renames it onto dest — a reader never observes a partially
// written file, and a failed write never corrupts the existing one.
func atomicWrite(dest string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(dest)
	tmp, err := os.CreateTemp(dir, ".telemt-panel-*")
	if err != nil {
		return fmt.Errorf("host: create temp file in %q: %w", dir, err)
	}
	tmpPath := tmp.Name()
	// No-op once the rename below succeeds; cleans up on every error path.
	defer os.Remove(tmpPath)

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("host: write %q: %w", tmpPath, err)
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return fmt.Errorf("host: chmod %q: %w", tmpPath, err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("host: sync %q: %w", tmpPath, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("host: close %q: %w", tmpPath, err)
	}
	if err := os.Rename(tmpPath, dest); err != nil {
		return fmt.Errorf("host: rename %q to %q: %w", tmpPath, dest, err)
	}
	return nil
}

// writeFileInPlace rewrites path's content in place (truncate + write +
// sync on the existing file descriptor), preserving the file's inode and
// therefore its owner, group and permission bits — reimplemented from
// v0's telemt_config write semantics (file_write.go's writeConfigInPlace)
// for the same reason: an operator-managed config file's ownership must
// survive an edit made through this agent/direct path. A path that
// doesn't exist yet is created fresh (nothing to preserve).
func writeFileInPlace(path, content string) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_TRUNC, 0)
	if err != nil {
		if os.IsNotExist(err) {
			return os.WriteFile(path, []byte(content), 0o600)
		}
		return fmt.Errorf("host: open %q: %w", path, err)
	}
	if _, err := f.WriteString(content); err != nil {
		f.Close()
		return fmt.Errorf("host: write %q: %w", path, err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return fmt.Errorf("host: sync %q: %w", path, err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("host: close %q: %w", path, err)
	}
	return nil
}

// formatLogLines renders read-journal's Tail result into Output.Stdout's
// plain-text form, one normalized line per entry.
func formatLogLines(lines []LogLine) string {
	var b strings.Builder
	for _, l := range lines {
		fmt.Fprintf(&b, "%s %s %s: %s\n", l.TS.Format(time.RFC3339), l.Level, l.Unit, l.Msg)
	}
	return b.String()
}
