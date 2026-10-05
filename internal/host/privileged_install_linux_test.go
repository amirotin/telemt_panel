package host

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/amirotin/telemt_panel/internal/atomicfile"

	"golang.org/x/sys/unix"
)

type privilegedFixture struct {
	policyPath string
	policy     PrivilegedPolicy
	owner      uint32
}

func TestPrivilegedPolicyRejectsDerivedBackupAndLockCollisions(t *testing.T) {
	for _, collision := range []string{"panel equals Telemt backup", "Telemt equals panel backup", "panel equals Telemt lock", "Telemt equals panel lock"} {
		t.Run(collision, func(t *testing.T) {
			f := newPrivilegedFixture(t)
			switch collision {
			case "panel equals Telemt backup":
				f.policy.Binaries["panel"] = f.policy.Binaries["telemt"] + ".bak"
			case "Telemt equals panel backup":
				f.policy.Binaries["telemt"] = f.policy.Binaries["panel"] + ".bak"
			case "panel equals Telemt lock":
				f.policy.Binaries["panel"] = filepath.Join(filepath.Dir(f.policy.Binaries["telemt"]), ".telemt-panel-telemt.lock")
			case "Telemt equals panel lock":
				f.policy.Binaries["telemt"] = filepath.Join(filepath.Dir(f.policy.Binaries["panel"]), ".telemt-panel-panel.lock")
			}
			f.writePolicy(t)
			if _, err := loadPrivilegedPolicy(f.policyPath, f.owner); err == nil {
				t.Fatal("derived privileged paths collide across targets")
			}
		})
	}
}

func TestPrivilegedPublicationUsesBoundedMemory(t *testing.T) {
	f := newPrivilegedFixture(t)
	sourcePath := filepath.Join(f.policy.StagingRoot, "runs", "panel", "bin")
	file, err := os.OpenFile(sourcePath, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(16 << 20); err != nil {
		t.Fatal(err)
	}
	file.Close()
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	if err := runPrivilegedInstallOwner(context.Background(), f.policyPath, "install", "panel", f.owner); err != nil {
		t.Fatal(err)
	}
	runtime.ReadMemStats(&after)
	if allocated := after.TotalAlloc - before.TotalAlloc; allocated > 4<<20 {
		t.Fatalf("privileged copy allocated %d bytes for 16 MiB binary", allocated)
	}
	info, err := os.Stat(f.policy.Binaries["panel"])
	if err != nil || info.Size() != 16<<20 || info.Mode().Perm() != 0o755 {
		t.Fatalf("published binary=%v error=%v", info, err)
	}
}

func TestPrivilegedPublicationUsesPinnedSourceAndDestinationDescriptors(t *testing.T) {
	f := newPrivilegedFixture(t)
	sourcePath := filepath.Join(f.policy.StagingRoot, "runs", "panel", "bin")
	source, err := openFileNoFollow(sourcePath, f.owner, false)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	directoryPath := filepath.Dir(f.policy.Binaries["panel"])
	directory, err := openDirectoryNoFollow(directoryPath, f.owner, true)
	if err != nil {
		t.Fatal(err)
	}
	defer directory.Close()
	if err := os.Rename(sourcePath, sourcePath+".pinned"); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("protected"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, sourcePath); err != nil {
		t.Fatal(err)
	}
	moved := directoryPath + ".pinned"
	if err := os.Rename(directoryPath, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Dir(outside), directoryPath); err != nil {
		t.Fatal(err)
	}
	if err := publishExecutableFD(context.Background(), source, directory, "panel", privilegedPublishOps{}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(moved, "panel"))
	if err != nil || string(data) != "new-panel" {
		t.Fatalf("pinned install=%q error=%v", data, err)
	}
	data, err = os.ReadFile(outside)
	if err != nil || string(data) != "protected" {
		t.Fatalf("outside file=%q error=%v", data, err)
	}
}

func TestPrivilegedPublicationFaultsRespectRenameBoundary(t *testing.T) {
	for _, fault := range []string{"file sync", "rename", "directory sync", "canceled"} {
		t.Run(fault, func(t *testing.T) {
			f := newPrivilegedFixture(t)
			source, err := openFileNoFollow(filepath.Join(f.policy.StagingRoot, "runs", "panel", "bin"), f.owner, false)
			if err != nil {
				t.Fatal(err)
			}
			defer source.Close()
			directory, err := openDirectoryNoFollow(filepath.Dir(f.policy.Binaries["panel"]), f.owner, true)
			if err != nil {
				t.Fatal(err)
			}
			defer directory.Close()
			cause := errors.New("injected " + fault)
			ops := privilegedPublishOps{}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if fault == "file sync" {
				ops.syncFile = func(*os.File) error { return cause }
			} else if fault == "rename" {
				ops.rename = func(int, string, int, string) error { return cause }
			} else if fault == "directory sync" {
				ops.syncDir = func(*os.File) error { return cause }
			} else {
				cancel()
				cause = context.Canceled
			}
			err = publishExecutableFD(ctx, source, directory, "panel", ops)
			if !errors.Is(err, cause) || atomicfile.Published(err) != (fault == "directory sync") {
				t.Fatalf("error=%v published=%v", err, atomicfile.Published(err))
			}
			want := "old-panel"
			if fault == "directory sync" {
				want = "new-panel"
			}
			data, err := os.ReadFile(f.policy.Binaries["panel"])
			if err != nil || string(data) != want {
				t.Fatalf("destination=%q error=%v", data, err)
			}
			files, err := os.ReadDir(filepath.Dir(f.policy.Binaries["panel"]))
			if err != nil || len(files) != 2 {
				t.Fatalf("temporary files leaked=%v error=%v", files, err)
			}
		})
	}
}

func TestPrivilegedTargetLockRejectsConcurrentMutation(t *testing.T) {
	f := newPrivilegedFixture(t)
	path := filepath.Join(filepath.Dir(f.policy.Binaries["panel"]), ".telemt-panel-panel.lock")
	lock, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	if err := runPrivilegedInstallOwner(context.Background(), f.policyPath, "install", "panel", f.owner); !errors.Is(err, ErrInstallInProgress) {
		t.Fatalf("concurrent install error=%v", err)
	}
	if err := unix.Flock(int(lock.Fd()), unix.LOCK_UN); err != nil {
		t.Fatal(err)
	}
	if err := runPrivilegedInstallOwner(context.Background(), f.policyPath, "install", "panel", f.owner); err != nil {
		t.Fatal(err)
	}
}

func newPrivilegedFixture(t *testing.T) privilegedFixture {
	t.Helper()
	root := t.TempDir()
	staging, binaries := filepath.Join(root, "staging"), filepath.Join(root, "binaries")
	for _, path := range []string{binaries, filepath.Join(staging, "runs", "panel"), filepath.Join(staging, "runs", "telemt")} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	helper := filepath.Join(root, "libexec", "privileged")
	if err := os.MkdirAll(filepath.Dir(helper), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(helper, []byte("independent helper fixture"), 0o755); err != nil {
		t.Fatal(err)
	}
	fixture := privilegedFixture{policyPath: filepath.Join(root, "policy.json"), owner: uint32(os.Geteuid()), policy: PrivilegedPolicy{Version: PrivilegedPolicyVersion, HelperPath: helper, StagingRoot: staging, Binaries: map[string]string{"panel": filepath.Join(binaries, "panel"), "telemt": filepath.Join(binaries, "telemt")}}}
	fixture.writePolicy(t)
	for _, target := range []string{"panel", "telemt"} {
		if err := os.WriteFile(fixture.policy.Binaries[target], []byte("old-"+target), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(staging, "runs", target, "bin"), []byte("new-"+target), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return fixture
}

func (f privilegedFixture) writePolicy(t *testing.T) {
	t.Helper()
	data, err := json.Marshal(f.policy)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.policyPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestPrivilegedInstallBackupRestoreFixedPaths(t *testing.T) {
	for _, target := range []string{"panel", "telemt"} {
		t.Run(target, func(t *testing.T) {
			f := newPrivilegedFixture(t)
			for _, operation := range []string{"backup", "install", "restore"} {
				if err := runPrivilegedInstallOwner(context.Background(), f.policyPath, operation, target, f.owner); err != nil {
					t.Fatal(operation, err)
				}
				want := "old-" + target
				if operation == "install" {
					want = "new-" + target
				}
				data, err := os.ReadFile(f.policy.Binaries[target])
				if err != nil || string(data) != want {
					t.Fatalf("%s binary=%q error=%v", operation, data, err)
				}
			}
		})
	}
}

func TestPrivilegedInstallRejectsSymlinksAndSpecialSources(t *testing.T) {
	for _, attack := range []string{"source", "source parent", "destination", "destination parent", "policy", "fifo", "oversize"} {
		t.Run(attack, func(t *testing.T) {
			f := newPrivilegedFixture(t)
			source := filepath.Join(f.policy.StagingRoot, "runs", "panel", "bin")
			outside := filepath.Join(t.TempDir(), "outside")
			if err := os.WriteFile(outside, []byte("protected"), 0o600); err != nil {
				t.Fatal(err)
			}
			switch attack {
			case "source":
				if err := os.Remove(source); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, source); err != nil {
					t.Fatal(err)
				}
			case "source parent":
				parent := filepath.Dir(source)
				moved := parent + ".moved"
				if err := os.Rename(parent, moved); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(moved, parent); err != nil {
					t.Fatal(err)
				}
			case "destination":
				if err := os.Remove(f.policy.Binaries["panel"]); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, f.policy.Binaries["panel"]); err != nil {
					t.Fatal(err)
				}
			case "destination parent":
				parent := filepath.Dir(f.policy.Binaries["panel"])
				moved := parent + ".moved"
				if err := os.Rename(parent, moved); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(moved, parent); err != nil {
					t.Fatal(err)
				}
			case "policy":
				moved := f.policyPath + ".moved"
				if err := os.Rename(f.policyPath, moved); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(moved, f.policyPath); err != nil {
					t.Fatal(err)
				}
			case "fifo":
				if err := os.Remove(source); err != nil {
					t.Fatal(err)
				}
				if err := unix.Mkfifo(source, 0o600); err != nil {
					t.Fatal(err)
				}
			case "oversize":
				file, err := os.OpenFile(source, os.O_WRONLY, 0)
				if err != nil {
					t.Fatal(err)
				}
				if err := file.Truncate(MaxBinaryCopySize + 1); err != nil {
					t.Fatal(err)
				}
				file.Close()
			}
			if err := runPrivilegedInstallOwner(context.Background(), f.policyPath, "install", "panel", f.owner); err == nil {
				t.Fatal("unsafe source/path accepted")
			}
			data, err := os.ReadFile(outside)
			if err != nil || string(data) != "protected" {
				t.Fatalf("outside file changed=%q error=%v", data, err)
			}
		})
	}
}

func TestPrivilegedPolicyRejectsWritableOwnerVersionAndShape(t *testing.T) {
	for _, invalid := range []string{"mode", "owner", "parent", "version", "unknown target", "alias paths", "policy size", "trailing JSON", "relative path"} {
		t.Run(invalid, func(t *testing.T) {
			f := newPrivilegedFixture(t)
			owner := f.owner
			switch invalid {
			case "mode":
				if err := os.Chmod(f.policyPath, 0o644); err != nil {
					t.Fatal(err)
				}
			case "owner":
				owner++
			case "parent":
				if err := os.Chmod(filepath.Dir(f.policyPath), 0o777); err != nil {
					t.Fatal(err)
				}
			case "version":
				f.policy.Version = 1
				f.writePolicy(t)
			case "unknown target":
				f.policy.Binaries["other"] = f.policy.Binaries["panel"]
				f.writePolicy(t)
			case "alias paths":
				f.policy.Binaries["telemt"] = f.policy.Binaries["panel"]
				f.writePolicy(t)
			case "policy size":
				if err := os.WriteFile(f.policyPath, make([]byte, (64<<10)+1), 0o600); err != nil {
					t.Fatal(err)
				}
			case "trailing JSON":
				data, err := os.ReadFile(f.policyPath)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(f.policyPath, append(data, []byte(" {}")...), 0o600); err != nil {
					t.Fatal(err)
				}
			case "relative path":
				f.policy.StagingRoot = "relative"
				f.writePolicy(t)
			}
			if _, err := loadPrivilegedPolicy(f.policyPath, owner); err == nil {
				t.Fatal("invalid root policy accepted")
			}
		})
	}
}

func TestPrivilegedInstallRejectsUnknownTargetAndOperation(t *testing.T) {
	f := newPrivilegedFixture(t)
	for _, pair := range [][2]string{{"install", "other"}, {"inspect", "panel"}, {"remove", "panel"}, {"install", ""}} {
		if err := runPrivilegedInstallOwner(context.Background(), f.policyPath, pair[0], pair[1], f.owner); err == nil {
			t.Fatal("forbidden operation accepted", pair)
		}
	}
}
