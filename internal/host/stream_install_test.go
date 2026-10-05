package host

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestInstallExecutableUsesBoundedMemory(t *testing.T) {
	directory := t.TempDir()
	source, destination := filepath.Join(directory, "source"), filepath.Join(directory, "destination")
	f, err := os.Create(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(16 << 20); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	if err := installExecutable(source, destination); err != nil {
		t.Fatal(err)
	}
	runtime.ReadMemStats(&after)
	if allocated := after.TotalAlloc - before.TotalAlloc; allocated > 4<<20 {
		t.Fatalf("install allocated %d bytes for 16 MiB binary; want bounded copy buffer", allocated)
	}
	info, err := os.Stat(destination)
	if err != nil || info.Size() != 16<<20 || info.Mode().Perm() != 0o755 {
		t.Fatalf("installed file=%v error=%v", info, err)
	}
}

func TestInstallExecutableRejectsOversizeWithoutPublication(t *testing.T) {
	directory := t.TempDir()
	source, destination := filepath.Join(directory, "source"), filepath.Join(directory, "destination")
	f, err := os.Create(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(MaxBinaryCopySize + 1); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(destination, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := installExecutable(source, destination); err == nil {
		t.Fatal("oversize binary was installed")
	}
	data, err := os.ReadFile(destination)
	if err != nil || string(data) != "old" {
		t.Fatalf("destination=%q error=%v", data, err)
	}
}
