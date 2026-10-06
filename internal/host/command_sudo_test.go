package host

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"testing/iotest"
	"time"

	"github.com/amirotin/telemt_panel/internal/atomicfile"
)

func TestDirectRunnerRemovesOnlyFixedUpdateArtifacts(t *testing.T) {
	directory := t.TempDir()
	binary := filepath.Join(directory, "panel")
	allow := AllowLists{BinaryPaths: []string{binary, binary + ".bak"}, TargetBinaries: map[string]string{"panel": binary}}
	runner := NewDirectRunner(allow, nil, nil)
	for _, suffix := range []string{"", ".bak", ".tmp", ".bak.tmp", ".other"} {
		if err := os.WriteFile(binary+suffix, []byte("keep or remove"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, suffix := range []string{".bak", ".tmp", ".bak.tmp"} {
		if _, err := runner.Run(context.Background(), Op{Kind: "remove-binary", Args: map[string]string{ArgDest: binary + suffix}}); err != nil {
			t.Fatalf("remove fixed artifact %s: %v", suffix, err)
		}
		if _, err := os.Stat(binary + suffix); !os.IsNotExist(err) {
			t.Fatalf("artifact %s still exists: %v", suffix, err)
		}
		if _, err := runner.Run(context.Background(), Op{Kind: "remove-binary", Args: map[string]string{ArgDest: binary + suffix}}); err != nil {
			t.Fatalf("idempotent cleanup %s: %v", suffix, err)
		}
	}
	for _, suffix := range []string{"", ".other"} {
		if _, err := runner.Run(context.Background(), Op{Kind: "remove-binary", Args: map[string]string{ArgDest: binary + suffix}}); err == nil {
			t.Fatalf("cleanup permitted protected path %s", binary+suffix)
		}
		if _, err := os.Stat(binary + suffix); err != nil {
			t.Fatalf("protected path %s removed: %v", suffix, err)
		}
	}
}

func TestCommandSudoRunnerPublishesStdinAndReadableBackup(t *testing.T) {
	dir := t.TempDir()
	staging := filepath.Join(dir, "staging")
	if err := os.Mkdir(staging, 0o700); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(dir, "panel")
	source := filepath.Join(staging, "candidate")
	if err := os.WriteFile(source, []byte("previous executable"), 0o600); err != nil {
		t.Fatal(err)
	}
	allow := AllowLists{BinaryPaths: []string{binary, binary + ".bak"}, TargetBinaries: map[string]string{"panel": binary}, StagingPrefix: staging}
	var calls []recordedCommand
	run := NewSudoCmdRunner(func(ctx context.Context, name string, args ...string) ([]byte, []byte, error) {
		calls = append(calls, recordedCommand{name, append([]string(nil), args...)})
		if name != "sudo" || len(args) < 3 || args[0] != "-n" || args[1] != "--" {
			t.Fatalf("unexpected sudo invocation %s %q", name, args)
		}
		return OSCmdRunner(ctx, args[2], args[3:]...)
	})
	stdin := NewSudoStdinCmdRunner(func(ctx context.Context, input io.Reader, name string, args ...string) ([]byte, []byte, error) {
		calls = append(calls, recordedCommand{name, append([]string(nil), args...)})
		if name != "sudo" || len(args) < 3 || args[0] != "-n" || args[1] != "--" {
			t.Fatalf("unexpected sudo stdin invocation %s %q", name, args)
		}
		// Removing the staging pathname proves the unprivileged caller already
		// opened the bytes before crossing the sudo command boundary.
		if args[len(args)-1] == binary+".bak.tmp" {
			if err := os.Remove(source); err != nil {
				t.Fatal(err)
			}
		}
		return OSStdinCmdRunner(ctx, input, args[2], args[3:]...)
	})
	runner := NewCommandSudoRunner(allow, nil, nil, run, stdin)
	if _, err := runner.Run(context.Background(), Op{Kind: OpInstallBinary, Args: map[string]string{ArgStaging: source, ArgDest: binary + ".bak"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := runner.Run(context.Background(), Op{Kind: OpRestoreBinary, Args: map[string]string{ArgBackup: binary + ".bak", ArgDest: binary}}); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{binary, binary + ".bak"} {
		data, err := os.ReadFile(path)
		if err != nil || string(data) != "previous executable" {
			t.Fatalf("published %s=%q: %v", path, data, err)
		}
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0o755 {
			t.Fatalf("worker-readable executable mode=%v: %v", info, err)
		}
	}
	want := []recordedCommand{
		{"sudo", []string{"-n", "--", "install", "-m", "0755", "/dev/stdin", binary + ".bak.tmp"}},
		{"sudo", []string{"-n", "--", "mv", "-f", binary + ".bak.tmp", binary + ".bak"}},
		{"sudo", []string{"-n", "--", "install", "-m", "0755", "/dev/stdin", binary + ".tmp"}},
		{"sudo", []string{"-n", "--", "mv", "-f", binary + ".tmp", binary}},
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("command policy mismatch: got %+v, want %+v", calls, want)
	}
}

func TestCommandSudoPolicyRunnerChecksAbsentSourcesAndFixedCleanup(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "never-created-panel")
	staging := filepath.Join(t.TempDir(), "never-created-staging")
	allow := AllowLists{BinaryPaths: []string{binary, binary + ".bak"}, TargetBinaries: map[string]string{"panel": binary}, StagingPrefix: staging}
	var calls []recordedCommand
	run := NewSudoPolicyCmdRunner(commandRecorder(&calls, 0))
	runner := NewCommandSudoPolicyRunner(allow, nil, nil, run)
	runner.syncPath = func(string) error {
		t.Fatal("policy probe tried opening a path for filesystem sync")
		return nil
	}
	ops := []Op{
		{Kind: OpInstallBinary, Args: map[string]string{ArgStaging: staging + "/candidate", ArgDest: binary}},
		{Kind: OpRestoreBinary, Args: map[string]string{ArgBackup: binary + ".bak", ArgDest: binary}},
		{Kind: "remove-binary", Args: map[string]string{ArgDest: binary + ".bak"}},
		{Kind: "remove-binary", Args: map[string]string{ArgDest: binary + ".tmp"}},
		{Kind: "remove-binary", Args: map[string]string{ArgDest: binary + ".bak.tmp"}},
	}
	if !ProbeRunner(context.Background(), runner, ops) {
		t.Fatal("policy probe tried opening nonexistent staging/backup or rejected fixed operations")
	}
	want := []recordedCommand{
		{"sudo", []string{"-n", "-l", "--", "install", "-m", "0755", "/dev/stdin", binary + ".tmp"}},
		{"sudo", []string{"-n", "-l", "--", "mv", "-f", binary + ".tmp", binary}},
		{"sudo", []string{"-n", "-l", "--", "install", "-m", "0755", "/dev/stdin", binary + ".tmp"}},
		{"sudo", []string{"-n", "-l", "--", "mv", "-f", binary + ".tmp", binary}},
		{"sudo", []string{"-n", "-l", "--", "rm", "-f", binary + ".bak"}},
		{"sudo", []string{"-n", "-l", "--", "rm", "-f", binary + ".tmp"}},
		{"sudo", []string{"-n", "-l", "--", "rm", "-f", binary + ".bak.tmp"}},
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("policy argv mismatch: got %+v, want %+v", calls, want)
	}
	calls = nil
	runner = NewCommandSudoPolicyRunner(allow, nil, nil, NewSudoPolicyCmdRunner(commandRecorder(&calls, 1)))
	if ProbeRunner(context.Background(), runner, ops) || len(calls) != 1 {
		t.Fatalf("denied policy continued: %+v", calls)
	}
}

func TestCommandSudoRunnerSyncsPublicationInOrder(t *testing.T) {
	for _, failure := range []string{"none", "file-sync", "directory-sync"} {
		t.Run(failure, func(t *testing.T) {
			dir := t.TempDir()
			binary, source := filepath.Join(dir, "panel"), filepath.Join(dir, "candidate")
			for path, data := range map[string]string{binary: "previous", source: "candidate"} {
				if err := os.WriteFile(path, []byte(data), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			var operations []string
			run := func(ctx context.Context, name string, args ...string) ([]byte, []byte, error) {
				operations = append(operations, name)
				return OSCmdRunner(ctx, name, args...)
			}
			stdin := func(ctx context.Context, input io.Reader, name string, args ...string) ([]byte, []byte, error) {
				operations = append(operations, name)
				return OSStdinCmdRunner(ctx, input, name, args...)
			}
			runner := NewCommandSudoRunner(AllowLists{BinaryPaths: []string{binary}, StagingPrefix: dir}, nil, nil, run, stdin)
			syncErr := errors.New("filesystem sync failed")
			runner.syncPath = func(path string) error {
				var operation string
				switch path {
				case binary + ".tmp":
					operation = "file-sync"
					if data, err := os.ReadFile(binary); err != nil || string(data) != "previous" {
						t.Fatalf("candidate published before file sync: %q, %v", data, err)
					}
				case dir:
					operation = "directory-sync"
					if data, err := os.ReadFile(binary); err != nil || string(data) != "candidate" {
						t.Fatalf("directory synced before publication: %q, %v", data, err)
					}
				default:
					t.Fatalf("unexpected filesystem sync path: %s", path)
				}
				operations = append(operations, operation)
				if failure == operation {
					return syncErr
				}
				file, err := os.Open(path)
				if err != nil {
					return err
				}
				return errors.Join(file.Sync(), file.Close())
			}
			_, err := runner.Run(context.Background(), Op{Kind: OpInstallBinary, Args: map[string]string{ArgStaging: source, ArgDest: binary}})
			wantOperations := []string{"install", "file-sync", "mv", "directory-sync"}
			wantContents := "candidate"
			if failure == "none" {
				if err != nil {
					t.Fatal(err)
				}
			} else {
				if !errors.Is(err, syncErr) {
					t.Fatalf("filesystem sync failure lost: %v", err)
				}
				if atomicfile.Published(err) != (failure == "directory-sync") {
					t.Fatalf("incorrect publication classification for %s: %v", failure, err)
				}
				if failure == "file-sync" {
					wantContents = "previous"
					wantOperations = []string{"install", "file-sync"}
				}
				wantOperations = append(wantOperations, "rm")
			}
			if !reflect.DeepEqual(operations, wantOperations) {
				t.Fatalf("durability operations=%v, want %v", operations, wantOperations)
			}
			if data, err := os.ReadFile(binary); err != nil || string(data) != wantContents {
				t.Fatalf("published contents=%q, want %q: %v", data, wantContents, err)
			}
			if _, err := os.Stat(binary + ".tmp"); !os.IsNotExist(err) {
				t.Fatalf("temporary executable left behind: %v", err)
			}
		})
	}
}

func TestCommandSudoRunnerFailedInstallNeverPublishes(t *testing.T) {
	dir := t.TempDir()
	binary, source := filepath.Join(dir, "panel"), filepath.Join(dir, "candidate")
	for _, path := range []string{binary, source} {
		if err := os.WriteFile(path, []byte("old"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	var commands []recordedCommand
	run := func(ctx context.Context, name string, args ...string) ([]byte, []byte, error) {
		commands = append(commands, recordedCommand{name, append([]string(nil), args...)})
		return OSCmdRunner(ctx, name, args...)
	}
	wantErr := errors.New("install failed after partial write")
	stdin := func(_ context.Context, _ io.Reader, _ string, _ ...string) ([]byte, []byte, error) {
		if err := os.WriteFile(binary+".tmp", []byte("partial"), 0o755); err != nil {
			t.Fatal(err)
		}
		return nil, nil, wantErr
	}
	allow := AllowLists{BinaryPaths: []string{binary}, TargetBinaries: map[string]string{"panel": binary}, StagingPrefix: dir}
	runner := NewCommandSudoRunner(allow, nil, nil, run, stdin)
	if _, err := runner.Run(context.Background(), Op{Kind: OpInstallBinary, Args: map[string]string{ArgStaging: source, ArgDest: binary}}); !errors.Is(err, wantErr) {
		t.Fatalf("lost install error: %v", err)
	}
	data, err := os.ReadFile(binary)
	if err != nil || string(data) != "old" {
		t.Fatalf("failed install published %q: %v", data, err)
	}
	if _, err := os.Stat(binary + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("partial temp retained: %v", err)
	}
	if !reflect.DeepEqual(commands, []recordedCommand{{"rm", []string{"-f", binary + ".tmp"}}}) {
		t.Fatalf("failed install commands=%+v", commands)
	}
}

func TestCommandSudoRunnerReadFailureDoesNotPublishPartialStream(t *testing.T) {
	dir := t.TempDir()
	binary, source := filepath.Join(dir, "panel"), filepath.Join(dir, "candidate")
	for path, data := range map[string]string{binary: "previous", source: "partial candidate"} {
		if err := os.WriteFile(path, []byte(data), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	readErr := errors.New("source read failed")
	stdin := func(ctx context.Context, input io.Reader, name string, args ...string) ([]byte, []byte, error) {
		return OSStdinCmdRunner(ctx, io.MultiReader(input, iotest.ErrReader(readErr)), name, args...)
	}
	allow := AllowLists{BinaryPaths: []string{binary}, StagingPrefix: dir}
	runner := NewCommandSudoRunner(allow, nil, nil, OSCmdRunner, stdin)
	if _, err := runner.Run(context.Background(), Op{Kind: OpInstallBinary, Args: map[string]string{ArgStaging: source, ArgDest: binary}}); !errors.Is(err, readErr) {
		t.Fatalf("stdin read error was lost: %v", err)
	}
	if data, err := os.ReadFile(binary); err != nil || string(data) != "previous" {
		t.Fatalf("partial stream published: %q, %v", data, err)
	}
	if _, err := os.Stat(binary + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("partial stream temporary retained: %v", err)
	}
}

func TestCommandSudoRunnerRenameErrorPreservesFailureAndCleanup(t *testing.T) {
	for _, renamed := range []bool{false, true} {
		t.Run(map[bool]string{false: "before rename", true: "after rename"}[renamed], func(t *testing.T) {
			dir := t.TempDir()
			binary, source := filepath.Join(dir, "panel"), filepath.Join(dir, "candidate")
			for path, data := range map[string]string{binary: "previous", source: "candidate"} {
				if err := os.WriteFile(path, []byte(data), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			renameErr := errors.New("rename result lost")
			run := func(ctx context.Context, name string, args ...string) ([]byte, []byte, error) {
				if name == "mv" {
					if renamed {
						if _, _, err := OSCmdRunner(ctx, name, args...); err != nil {
							t.Fatal(err)
						}
					}
					return nil, nil, renameErr
				}
				return OSCmdRunner(ctx, name, args...)
			}
			runner := NewCommandSudoRunner(AllowLists{BinaryPaths: []string{binary}, StagingPrefix: dir}, nil, nil, run, OSStdinCmdRunner)
			_, err := runner.Run(context.Background(), Op{Kind: OpInstallBinary, Args: map[string]string{ArgStaging: source, ArgDest: binary}})
			if !errors.Is(err, renameErr) || strings.Contains(err.Error(), "directory durability") {
				t.Fatalf("rename failure was lost or misclassified: %v", err)
			}
			want := "previous"
			if renamed {
				want = "candidate"
			}
			if data, err := os.ReadFile(binary); err != nil || string(data) != want {
				t.Fatalf("rename state=%q, want %q: %v", data, want, err)
			}
			if _, err := os.Stat(binary + ".tmp"); !os.IsNotExist(err) {
				t.Fatalf("rename failure left temporary: %v", err)
			}
		})
	}
}

func TestCommandSudoRunnerRejectsUnauthorizedOperationsBeforeCommands(t *testing.T) {
	allow := AllowLists{BinaryPaths: []string{"/bin/panel", "/bin/panel.bak", "/bin/telemt", "/bin/telemt.bak"}, TargetBinaries: map[string]string{"panel": "/bin/panel", "telemt": "/bin/telemt"}, StagingPrefix: "/staging", Services: []string{"panel"}, ControlServices: []string{"telemt"}}
	var calls []recordedCommand
	run := commandRecorder(&calls, 0)
	runner := NewCommandSudoPolicyRunner(allow, NewSystemd(run), nil, run)
	for _, op := range []Op{
		{Kind: OpInstallBinary, Args: map[string]string{ArgStaging: "/staging-evil/candidate", ArgDest: "/bin/panel"}},
		{Kind: OpInstallBinary, Args: map[string]string{ArgStaging: "/staging/candidate", ArgDest: "/bin/other"}},
		{Kind: OpRestoreBinary, Args: map[string]string{ArgBackup: "/bin/telemt.bak", ArgDest: "/bin/panel"}},
		{Kind: "remove-binary", Args: map[string]string{ArgDest: "/bin/panel"}},
		{Kind: "remove-binary", Args: map[string]string{ArgDest: "/bin/other.bak"}},
		{Kind: OpStartService, Args: map[string]string{ArgService: "panel"}},
		{Kind: OpStopService, Args: map[string]string{ArgService: "other"}},
		{Kind: OpRestartService, Args: map[string]string{ArgService: "other"}},
	} {
		if _, err := runner.Run(context.Background(), op); err == nil {
			t.Fatalf("unapproved op accepted: %+v", op)
		}
	}
	if len(calls) != 0 {
		t.Fatalf("unapproved operations ran commands: %+v", calls)
	}
}

func TestCommandSudoPolicyRunnerUsesExactNativeAndEntwareServiceControls(t *testing.T) {
	for _, kind := range []string{"systemd", "procd", "entware"} {
		t.Run(kind, func(t *testing.T) {
			var calls []recordedCommand
			run := NewSudoPolicyCmdRunner(commandRecorder(&calls, 0))
			var manager ServiceManager
			var want []recordedCommand
			switch kind {
			case "systemd":
				manager = NewSystemd(run)
				want = []recordedCommand{
					{"sudo", []string{"-n", "-l", "--", "systemctl", "start", "panel"}},
					{"sudo", []string{"-n", "-l", "--", "systemctl", "stop", "panel"}},
					{"sudo", []string{"-n", "-l", "--", "systemctl", "restart", "panel"}},
				}
			case "procd":
				manager = NewProcd(run)
				want = []recordedCommand{
					{"sudo", []string{"-n", "-l", "--", "/etc/init.d/panel", "start"}},
					{"sudo", []string{"-n", "-l", "--", "/etc/init.d/panel", "stop"}},
					{"sudo", []string{"-n", "-l", "--", "/etc/init.d/panel", "restart"}},
				}
			case "entware":
				manager = NewCustom("telemt", "panel", CustomCommands{Panel: PanelCommands{
					Start: []string{"/opt/etc/init.d/S99panel", "start"}, Stop: []string{"/opt/etc/init.d/S99panel", "stop"}, Restart: []string{"/opt/etc/init.d/S99panel", "restart"},
				}}, run)
				want = []recordedCommand{
					{"sudo", []string{"-n", "-l", "--", "/opt/etc/init.d/S99panel", "start"}},
					{"sudo", []string{"-n", "-l", "--", "/opt/etc/init.d/S99panel", "stop"}},
					{"sudo", []string{"-n", "-l", "--", "/opt/etc/init.d/S99panel", "restart"}},
				}
			}
			runner := NewCommandSudoPolicyRunner(AllowLists{Services: []string{"panel"}, ControlServices: []string{"panel"}}, manager, nil, run)
			for _, operation := range []string{OpStartService, OpStopService, OpRestartService} {
				if _, err := runner.Run(context.Background(), Op{Kind: operation, Args: map[string]string{ArgService: "panel"}}); err != nil {
					t.Fatal(err)
				}
			}
			if !reflect.DeepEqual(calls, want) {
				t.Fatalf("%s policy commands=%+v, want %+v", kind, calls, want)
			}
		})
	}
}

func TestCommandSudoRunnerStreamsWithBoundedMemoryAndRejectsOversize(t *testing.T) {
	dir := t.TempDir()
	binary, source := filepath.Join(dir, "panel"), filepath.Join(dir, "candidate")
	f, err := os.Create(source)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := f.Truncate(16 << 20); err != nil {
		t.Fatal(err)
	}
	allow := AllowLists{BinaryPaths: []string{binary}, TargetBinaries: map[string]string{"panel": binary}, StagingPrefix: dir}
	runner := NewCommandSudoRunner(allow, nil, nil, OSCmdRunner, OSStdinCmdRunner)
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	if _, err := runner.Run(context.Background(), Op{Kind: OpInstallBinary, Args: map[string]string{ArgStaging: source, ArgDest: binary}}); err != nil {
		t.Fatal(err)
	}
	runtime.ReadMemStats(&after)
	if allocated := after.TotalAlloc - before.TotalAlloc; allocated > 4<<20 {
		t.Fatalf("16 MiB stdin install allocated %d bytes", allocated)
	}
	if err := f.Truncate(MaxBinaryCopySize + 1); err != nil {
		t.Fatal(err)
	}
	if _, err := runner.Run(context.Background(), Op{Kind: OpInstallBinary, Args: map[string]string{ArgStaging: source, ArgDest: binary}}); err == nil {
		t.Fatal("oversize source accepted")
	}
	if info, err := os.Stat(binary); err != nil || info.Size() != 16<<20 {
		t.Fatalf("oversize source replaced valid binary: %v, %v", info, err)
	}
}

func TestOSStdinCmdRunnerBoundsOutputAndReportsExit(t *testing.T) {
	out, stderr, err := OSStdinCmdRunner(context.Background(), strings.NewReader("stdin-payload"), "sh", "-c", "cat; head -c 262144 /dev/zero; head -c 262144 /dev/zero >&2; exit 7")
	var exit *ExitError
	if !errors.As(err, &exit) || exit.Code != 7 {
		t.Fatalf("exit error=%v", err)
	}
	if !strings.HasPrefix(string(out), "stdin-payload") || len(out) > 64<<10 || len(stderr) > 64<<10 {
		t.Fatalf("stdin/output bounds failed: stdout=%d stderr=%d", len(out), len(stderr))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	started := time.Now()
	if _, _, err := OSStdinCmdRunner(ctx, nil, "sleep", "5"); err == nil || time.Since(started) > 2*time.Second {
		t.Fatalf("cancelled subprocess did not terminate promptly: %v", err)
	}
}
