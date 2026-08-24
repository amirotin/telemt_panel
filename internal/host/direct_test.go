// direct_test.go exercises directRunner only through the exported Runner
// surface (host.NewDirectRunner), so it lives in the external host_test
// package rather than package host: that lets it import host/hosttest for
// ServiceManager/LogSource fakes without an import cycle (an internal
// host test file can't import a package that itself imports host).
package host_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/host/hosttest"
)

func inode(t *testing.T, path string) uint64 {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %q: %v", path, err)
	}
	sys, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		t.Fatalf("Sys() is not *syscall.Stat_t on this platform")
	}
	return sys.Ino
}

func TestDirectRunner_InstallBinary_AtomicWriteMode0755(t *testing.T) {
	dir := t.TempDir()
	stagingDir := filepath.Join(dir, "staging")
	os.MkdirAll(stagingDir, 0o755)
	staging := filepath.Join(stagingDir, "staging-telemt")
	dest := filepath.Join(dir, "telemt")
	if err := os.WriteFile(staging, []byte("new binary bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Pre-existing dest with different content and mode, to prove install
	// overwrites content and forces the mode rather than inheriting it.
	if err := os.WriteFile(dest, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}

	r := host.NewDirectRunner(host.AllowLists{BinaryPaths: []string{dest}, StagingPrefix: stagingDir}, nil, nil)
	_, err := r.Run(context.Background(), host.Op{Kind: host.OpInstallBinary, Args: map[string]string{
		host.ArgStaging: staging, host.ArgDest: dest,
	}})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new binary bytes" {
		t.Errorf("dest content = %q", got)
	}
	info, err := os.Stat(dest)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Errorf("dest mode = %v, want 0755", info.Mode().Perm())
	}
}

func TestDirectRunner_InstallBinary_RejectsDestNotAllowed(t *testing.T) {
	dir := t.TempDir()
	stagingDir := filepath.Join(dir, "staging")
	os.MkdirAll(stagingDir, 0o755)
	staging := filepath.Join(stagingDir, "staging")
	dest := filepath.Join(dir, "telemt")
	os.WriteFile(staging, []byte("x"), 0o644)

	r := host.NewDirectRunner(host.AllowLists{BinaryPaths: []string{filepath.Join(dir, "other-allowed")}, StagingPrefix: stagingDir}, nil, nil)
	_, err := r.Run(context.Background(), host.Op{Kind: host.OpInstallBinary, Args: map[string]string{
		host.ArgStaging: staging, host.ArgDest: dest,
	}})
	if err == nil {
		t.Fatal("want error for a dest outside the allow-list, got nil")
	}
	if !strings.Contains(err.Error(), "not in the allowed path list") {
		t.Errorf("error %q doesn't explain the allow-list rejection", err)
	}
	if _, statErr := os.Stat(dest); !os.IsNotExist(statErr) {
		t.Error("dest must not have been written")
	}
}

func TestDirectRunner_InstallBinary_RejectsRelativeAndTraversalDest(t *testing.T) {
	dir := t.TempDir()
	stagingDir := filepath.Join(dir, "staging")
	os.MkdirAll(stagingDir, 0o755)
	staging := filepath.Join(stagingDir, "staging")
	os.WriteFile(staging, []byte("x"), 0o644)
	allowedDest := filepath.Join(dir, "telemt")

	cases := []struct {
		name string
		dest string
	}{
		{"relative", "telemt"},
		// filepath.Join would Clean this back to a traversal-free path, so
		// the ".." segment is built by direct string concatenation instead.
		{"traversal", dir + "/../" + filepath.Base(dir) + "/telemt"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := host.NewDirectRunner(host.AllowLists{BinaryPaths: []string{allowedDest, tc.dest}, StagingPrefix: stagingDir}, nil, nil)
			_, err := r.Run(context.Background(), host.Op{Kind: host.OpInstallBinary, Args: map[string]string{
				host.ArgStaging: staging, host.ArgDest: tc.dest,
			}})
			if err == nil {
				t.Fatalf("want error for dest %q, got nil", tc.dest)
			}
		})
	}
}

// TestDirectRunner_InstallBinary_RejectsStagingOutsidePrefix is FINDING
// 1's core regression test: without the prefix check, a staging path
// anywhere on disk (e.g. a secret file the agent process can read) would
// be copied verbatim into an allow-listed, world-readable-mode-0755
// dest — an arbitrary-file-read primitive.
func TestDirectRunner_InstallBinary_RejectsStagingOutsidePrefix(t *testing.T) {
	dir := t.TempDir()
	stagingDir := filepath.Join(dir, "staging")
	os.MkdirAll(stagingDir, 0o755)
	secret := filepath.Join(dir, "secret-not-in-staging")
	os.WriteFile(secret, []byte("top secret"), 0o600)
	dest := filepath.Join(dir, "telemt")

	r := host.NewDirectRunner(host.AllowLists{BinaryPaths: []string{dest}, StagingPrefix: stagingDir}, nil, nil)
	_, err := r.Run(context.Background(), host.Op{Kind: host.OpInstallBinary, Args: map[string]string{
		host.ArgStaging: secret, host.ArgDest: dest,
	}})
	if err == nil {
		t.Fatal("want error for a staging path outside the staging prefix, got nil")
	}
	if !strings.Contains(err.Error(), "staging prefix") {
		t.Errorf("error %q doesn't explain the staging-prefix rejection", err)
	}
	if _, statErr := os.Stat(dest); !os.IsNotExist(statErr) {
		t.Error("dest must not have been written")
	}
}

// TestDirectRunner_InstallBinary_RejectsStagingPrefixSiblingTrick proves
// the prefix check isn't a naive strings.HasPrefix: a sibling directory
// that merely shares the prefix string (e.g. ".../staging-evil" against
// prefix ".../staging") must not pass.
func TestDirectRunner_InstallBinary_RejectsStagingPrefixSiblingTrick(t *testing.T) {
	dir := t.TempDir()
	stagingDir := filepath.Join(dir, "staging")
	evilDir := filepath.Join(dir, "staging-evil")
	os.MkdirAll(stagingDir, 0o755)
	os.MkdirAll(evilDir, 0o755)
	evilFile := filepath.Join(evilDir, "payload")
	os.WriteFile(evilFile, []byte("x"), 0o644)
	dest := filepath.Join(dir, "telemt")

	r := host.NewDirectRunner(host.AllowLists{BinaryPaths: []string{dest}, StagingPrefix: stagingDir}, nil, nil)
	_, err := r.Run(context.Background(), host.Op{Kind: host.OpInstallBinary, Args: map[string]string{
		host.ArgStaging: evilFile, host.ArgDest: dest,
	}})
	if err == nil {
		t.Fatal("want error: a same-prefix-string sibling directory must not pass the staging-prefix check")
	}
}

// TestDirectRunner_InstallBinary_RejectsSymlinkStagingSource proves finding
// 1's fix: requireWithinPrefix only validates the staging path as a
// STRING, so a symlink planted inside the (allowed) staging dir but
// pointing outside it must still be refused when the file is actually
// opened for reading — otherwise it's an arbitrary-file-read primitive
// identical in effect to TestDirectRunner_InstallBinary_RejectsStagingOutsidePrefix,
// just reached through a symlink instead of a raw path.
func TestDirectRunner_InstallBinary_RejectsSymlinkStagingSource(t *testing.T) {
	dir := t.TempDir()
	stagingDir := filepath.Join(dir, "staging")
	os.MkdirAll(stagingDir, 0o755)
	secret := filepath.Join(dir, "secret-not-in-staging")
	os.WriteFile(secret, []byte("top secret"), 0o600)
	link := filepath.Join(stagingDir, "staging-telemt")
	if err := os.Symlink(secret, link); err != nil {
		t.Fatalf("Symlink: %v", err)
	}
	dest := filepath.Join(dir, "telemt")

	r := host.NewDirectRunner(host.AllowLists{BinaryPaths: []string{dest}, StagingPrefix: stagingDir}, nil, nil)
	_, err := r.Run(context.Background(), host.Op{Kind: host.OpInstallBinary, Args: map[string]string{
		host.ArgStaging: link, host.ArgDest: dest,
	}})
	if err == nil {
		t.Fatal("want error: a symlink under the staging prefix pointing outside it must be rejected, not followed")
	}
	if _, statErr := os.Stat(dest); !os.IsNotExist(statErr) {
		t.Error("dest must not have been written")
	}
}

func TestDirectRunner_InstallBinary_RejectsWhenStagingPrefixUnconfigured(t *testing.T) {
	dir := t.TempDir()
	staging := filepath.Join(dir, "staging-telemt")
	dest := filepath.Join(dir, "telemt")
	os.WriteFile(staging, []byte("x"), 0o644)

	r := host.NewDirectRunner(host.AllowLists{BinaryPaths: []string{dest}}, nil, nil) // StagingPrefix left empty
	_, err := r.Run(context.Background(), host.Op{Kind: host.OpInstallBinary, Args: map[string]string{
		host.ArgStaging: staging, host.ArgDest: dest,
	}})
	if err == nil {
		t.Fatal("want error: an empty staging prefix must reject every staging path, not allow everything")
	}
}

func TestDirectRunner_RestoreBinary_AtomicWriteMode0755(t *testing.T) {
	dir := t.TempDir()
	backup := filepath.Join(dir, "telemt.backup")
	dest := filepath.Join(dir, "telemt")
	os.WriteFile(backup, []byte("restored bytes"), 0o644)
	os.WriteFile(dest, []byte("broken new version"), 0o755)

	r := host.NewDirectRunner(host.AllowLists{BinaryPaths: []string{backup, dest}}, nil, nil)
	_, err := r.Run(context.Background(), host.Op{Kind: host.OpRestoreBinary, Args: map[string]string{
		host.ArgBackup: backup, host.ArgDest: dest,
	}})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	got, _ := os.ReadFile(dest)
	if string(got) != "restored bytes" {
		t.Errorf("dest content = %q", got)
	}
}

func TestDirectRunner_RestoreBinary_RejectsBackupNotAllowed(t *testing.T) {
	dir := t.TempDir()
	backup := filepath.Join(dir, "telemt.backup")
	dest := filepath.Join(dir, "telemt")
	os.WriteFile(backup, []byte("x"), 0o644)

	// dest is allowed, backup is not — restore must still be rejected,
	// since an unvalidated backup source is exactly what carries
	// attacker-controlled content into a protected dest.
	r := host.NewDirectRunner(host.AllowLists{BinaryPaths: []string{dest}}, nil, nil)
	_, err := r.Run(context.Background(), host.Op{Kind: host.OpRestoreBinary, Args: map[string]string{
		host.ArgBackup: backup, host.ArgDest: dest,
	}})
	if err == nil {
		t.Fatal("want error for a backup path outside the allow-list, got nil")
	}
}

func TestDirectRunner_RestartService_DelegatesToServiceManager(t *testing.T) {
	svcMgr := &hosttest.ServiceManager{}
	r := host.NewDirectRunner(host.AllowLists{Services: []string{"telemt"}}, svcMgr, nil)
	_, err := r.Run(context.Background(), host.Op{Kind: host.OpRestartService, Args: map[string]string{host.ArgService: "telemt"}})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(svcMgr.RestartCalls) != 1 || svcMgr.RestartCalls[0] != "telemt" {
		t.Errorf("RestartCalls = %v", svcMgr.RestartCalls)
	}
}

func TestDirectRunner_RestartService_PropagatesServiceManagerError(t *testing.T) {
	wantErr := errors.New("boom")
	svcMgr := &hosttest.ServiceManager{RestartErr: wantErr}
	r := host.NewDirectRunner(host.AllowLists{Services: []string{"telemt"}}, svcMgr, nil)
	_, err := r.Run(context.Background(), host.Op{Kind: host.OpRestartService, Args: map[string]string{host.ArgService: "telemt"}})
	if !errors.Is(err, wantErr) {
		t.Errorf("err = %v, want wrapping %v", err, wantErr)
	}
}

func TestDirectRunner_RestartService_RejectsServiceNotAllowed(t *testing.T) {
	svcMgr := &hosttest.ServiceManager{}
	r := host.NewDirectRunner(host.AllowLists{Services: []string{"telemt"}}, svcMgr, nil)
	_, err := r.Run(context.Background(), host.Op{Kind: host.OpRestartService, Args: map[string]string{host.ArgService: "nginx"}})
	if err == nil {
		t.Fatal("want error for a service outside the allow-list, got nil")
	}
	if len(svcMgr.RestartCalls) != 0 {
		t.Errorf("ServiceManager.Restart must not be called for a disallowed service, got calls %v", svcMgr.RestartCalls)
	}
}

func TestDirectRunner_RestartService_RejectsServiceStartingWithDash(t *testing.T) {
	svcMgr := &hosttest.ServiceManager{}
	r := host.NewDirectRunner(host.AllowLists{Services: []string{"-f"}}, svcMgr, nil)
	_, err := r.Run(context.Background(), host.Op{Kind: host.OpRestartService, Args: map[string]string{host.ArgService: "-f"}})
	if err == nil {
		t.Fatal("want error for a service name beginning with \"-\", got nil")
	}
	if len(svcMgr.RestartCalls) != 0 {
		t.Errorf("ServiceManager.Restart must not be called, got calls %v", svcMgr.RestartCalls)
	}
}

func TestDirectRunner_ReadJournal_DelegatesToLogSourceAndFormats(t *testing.T) {
	lines := []host.LogLine{
		{TS: mustParseTime(t, "2026-08-24T12:00:00Z"), Level: "info", Unit: "telemt", Msg: "started"},
		{TS: mustParseTime(t, "2026-08-24T12:00:01Z"), Level: "error", Unit: "telemt", Msg: "boom"},
	}
	logSrc := &hosttest.LogSource{TailResult: lines}
	r := host.NewDirectRunner(host.AllowLists{Services: []string{"telemt"}}, nil, logSrc)
	out, err := r.Run(context.Background(), host.Op{Kind: host.OpReadJournal, Args: map[string]string{
		host.ArgService: "telemt", host.ArgLines: "50",
	}})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(logSrc.TailCalls) != 1 || logSrc.TailCalls[0].Service != "telemt" || logSrc.TailCalls[0].Lines != 50 {
		t.Errorf("TailCalls = %v", logSrc.TailCalls)
	}
	want := "2026-08-24T12:00:00Z info telemt: started\n2026-08-24T12:00:01Z error telemt: boom\n"
	if out.Stdout != want {
		t.Errorf("Stdout = %q, want %q", out.Stdout, want)
	}
}

func TestDirectRunner_ReadJournal_RejectsServiceNotAllowed(t *testing.T) {
	logSrc := &hosttest.LogSource{}
	r := host.NewDirectRunner(host.AllowLists{Services: []string{"telemt"}}, nil, logSrc)
	_, err := r.Run(context.Background(), host.Op{Kind: host.OpReadJournal, Args: map[string]string{
		host.ArgService: "nginx", host.ArgLines: "10",
	}})
	if err == nil {
		t.Fatal("want error, got nil")
	}
	if len(logSrc.TailCalls) != 0 {
		t.Errorf("LogSource.Tail must not be called, got calls %v", logSrc.TailCalls)
	}
}

func TestDirectRunner_ReadJournal_BoundsLines(t *testing.T) {
	cases := []struct {
		name  string
		lines string
	}{
		{"zero", "0"},
		{"negative", "-1"},
		{"too large", "1000000"},
		{"not an integer", "many"},
		{"empty", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			logSrc := &hosttest.LogSource{}
			r := host.NewDirectRunner(host.AllowLists{Services: []string{"telemt"}}, nil, logSrc)
			_, err := r.Run(context.Background(), host.Op{Kind: host.OpReadJournal, Args: map[string]string{
				host.ArgService: "telemt", host.ArgLines: tc.lines,
			}})
			if err == nil {
				t.Fatalf("lines=%q: want error, got nil", tc.lines)
			}
			if len(logSrc.TailCalls) != 0 {
				t.Errorf("lines=%q: LogSource.Tail must not be called, got calls %v", tc.lines, logSrc.TailCalls)
			}
		})
	}
}

func TestDirectRunner_WriteConfig_PreservesInodeAndMode(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "telemt.toml")
	if err := os.WriteFile(path, []byte("old = true\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	wantIno := inode(t, path)

	r := host.NewDirectRunner(host.AllowLists{ConfigPaths: []string{path}}, nil, nil)
	_, err := r.Run(context.Background(), host.Op{Kind: host.OpWriteConfig, Args: map[string]string{
		host.ArgPath: path, host.ArgContent: "new = true\n",
	}})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new = true\n" {
		t.Errorf("content = %q", got)
	}
	if gotIno := inode(t, path); gotIno != wantIno {
		t.Errorf("inode changed: got %d, want %d (write must be in-place, not replace-the-file)", gotIno, wantIno)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o640 {
		t.Errorf("mode changed: got %v, want 0640 (preserved from before the write)", info.Mode().Perm())
	}
}

func TestDirectRunner_WriteConfig_CreatesFreshFileWhenMissing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "new-config.toml")

	r := host.NewDirectRunner(host.AllowLists{ConfigPaths: []string{path}}, nil, nil)
	_, err := r.Run(context.Background(), host.Op{Kind: host.OpWriteConfig, Args: map[string]string{
		host.ArgPath: path, host.ArgContent: "fresh = true\n",
	}})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "fresh = true\n" {
		t.Errorf("content = %q", got)
	}
}

func TestDirectRunner_WriteConfig_RejectsPathNotAllowed(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "telemt.toml")
	os.WriteFile(path, []byte("old"), 0o600)

	r := host.NewDirectRunner(host.AllowLists{ConfigPaths: []string{filepath.Join(dir, "other.toml")}}, nil, nil)
	_, err := r.Run(context.Background(), host.Op{Kind: host.OpWriteConfig, Args: map[string]string{
		host.ArgPath: path, host.ArgContent: "new",
	}})
	if err == nil {
		t.Fatal("want error, got nil")
	}
	got, _ := os.ReadFile(path)
	if string(got) != "old" {
		t.Errorf("file must not have been touched, content = %q", got)
	}
}

// TestDirectRunner_BinaryPathsAndConfigPathsAreNotCrossAddressable is
// FINDING 2's regression test: a path allow-listed only for one purpose
// (binary install/restore vs. config rewrite) must not validate for the
// other op kind, even though both ops go through the same
// requireAllowedPath check internally.
func TestDirectRunner_BinaryPathsAndConfigPathsAreNotCrossAddressable(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "telemt.toml")
	binaryDest := filepath.Join(dir, "telemt")
	os.WriteFile(configPath, []byte("old"), 0o600)

	t.Run("config path is not install-binary-addressable", func(t *testing.T) {
		stagingDir := filepath.Join(dir, "staging")
		os.MkdirAll(stagingDir, 0o755)
		staging := filepath.Join(stagingDir, "s")
		os.WriteFile(staging, []byte("x"), 0o644)

		// configPath is only in ConfigPaths, not BinaryPaths.
		r := host.NewDirectRunner(host.AllowLists{ConfigPaths: []string{configPath}, StagingPrefix: stagingDir}, nil, nil)
		_, err := r.Run(context.Background(), host.Op{Kind: host.OpInstallBinary, Args: map[string]string{
			host.ArgStaging: staging, host.ArgDest: configPath,
		}})
		if err == nil {
			t.Fatal("want error: a ConfigPaths-only entry must not be install-binary-addressable")
		}
	})

	t.Run("binary dest is not write-config-addressable", func(t *testing.T) {
		// binaryDest is only in BinaryPaths, not ConfigPaths.
		r := host.NewDirectRunner(host.AllowLists{BinaryPaths: []string{binaryDest}}, nil, nil)
		_, err := r.Run(context.Background(), host.Op{Kind: host.OpWriteConfig, Args: map[string]string{
			host.ArgPath: binaryDest, host.ArgContent: "malicious",
		}})
		if err == nil {
			t.Fatal("want error: a BinaryPaths-only entry must not be write-config-addressable")
		}
	})
}

func TestDirectRunner_RejectsUnknownKind(t *testing.T) {
	r := host.NewDirectRunner(host.AllowLists{}, nil, nil)
	_, err := r.Run(context.Background(), host.Op{Kind: "delete-everything"})
	if err == nil {
		t.Fatal("want error for an unknown op kind, got nil")
	}
}

func TestDirectRunner_MissingRequiredArg(t *testing.T) {
	r := host.NewDirectRunner(host.AllowLists{BinaryPaths: []string{"/x"}}, nil, nil)
	_, err := r.Run(context.Background(), host.Op{Kind: host.OpInstallBinary, Args: map[string]string{host.ArgDest: "/x"}})
	if err == nil {
		t.Fatal("want error for missing \"staging\" arg, got nil")
	}
}

func mustParseTime(t *testing.T, s string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}
