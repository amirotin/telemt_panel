package atomicfile

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestWritePublishesPermissionsAndDurabilityOrder(t *testing.T) {
	directory := t.TempDir()
	destination := filepath.Join(directory, "file")
	if err := os.WriteFile(destination, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	ops := defaultOps()
	var order []string
	ops.syncFile = func(f *os.File) error { order = append(order, "file sync"); return f.Sync() }
	ops.rename = func(from, to string) error { order = append(order, "rename"); return os.Rename(from, to) }
	ops.syncDir = func(path string) error { order = append(order, "directory sync"); return syncDirectory(path) }
	published, err := writeWithOps(destination, 0o600, func(w io.Writer) error { _, err := io.WriteString(w, "new"); return err }, ops)
	if err != nil || !published {
		t.Fatalf("published=%v error=%v", published, err)
	}
	if len(order) != 3 || order[0] != "file sync" || order[1] != "rename" || order[2] != "directory sync" {
		t.Fatalf("durability order=%v", order)
	}
	data, err := os.ReadFile(destination)
	if err != nil || string(data) != "new" {
		t.Fatalf("destination=%q error=%v", data, err)
	}
	info, err := os.Stat(destination)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("permissions=%v error=%v", info, err)
	}
}

func TestWriteFaultsPreservePublicationBoundaryAndCleanTemps(t *testing.T) {
	for _, fault := range []string{"write", "file sync", "close", "rename", "directory sync"} {
		t.Run(fault, func(t *testing.T) {
			directory := t.TempDir()
			destination := filepath.Join(directory, "file")
			if err := os.WriteFile(destination, []byte("old"), 0o600); err != nil {
				t.Fatal(err)
			}
			cause := errors.New("injected " + fault)
			ops := defaultOps()
			write := func(w io.Writer) error {
				_, err := io.WriteString(w, "new")
				if fault == "write" {
					return cause
				}
				return err
			}
			switch fault {
			case "file sync":
				ops.syncFile = func(*os.File) error { return cause }
			case "close":
				ops.closeFile = func(f *os.File) error { return errors.Join(f.Close(), cause) }
			case "rename":
				ops.rename = func(string, string) error { return cause }
			case "directory sync":
				ops.syncDir = func(string) error { return cause }
			}
			published, err := writeWithOps(destination, 0o755, write, ops)
			if !errors.Is(err, cause) || published != (fault == "directory sync") {
				t.Fatalf("published=%v error=%v", published, err)
			}
			if Published(err) != published {
				t.Fatalf("publication error classification=%v, published=%v", Published(err), published)
			}
			data, readErr := os.ReadFile(destination)
			want := "old"
			if published {
				want = "new"
			}
			if readErr != nil || string(data) != want {
				t.Fatalf("destination=%q error=%v", data, readErr)
			}
			files, listErr := os.ReadDir(directory)
			if listErr != nil || len(files) != 1 {
				t.Fatalf("temporary files leaked: %v error=%v", files, listErr)
			}
		})
	}
}

func TestWriteMissingDirectoryNeverPublishes(t *testing.T) {
	called := false
	published, err := Write(filepath.Join(t.TempDir(), "missing", "file"), 0o600, func(io.Writer) error { called = true; return nil })
	if err == nil || published || called {
		t.Fatalf("published=%v called=%v error=%v", published, called, err)
	}
}
