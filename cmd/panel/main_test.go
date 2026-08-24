package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/amirotin/telemt_panel/internal/config"
)

func TestNewStoreRefusesSQLiteDriver(t *testing.T) {
	cfg := &config.Config{Store: config.StoreConfig{Driver: "sqlite", Path: "/tmp/panel.db"}}
	_, err := newStore(cfg)
	if err == nil {
		t.Fatal("newStore: want an error for the unimplemented sqlite driver")
	}
	if !strings.Contains(err.Error(), `"sqlite"`) || !strings.Contains(err.Error(), `"memory"`) {
		t.Errorf("newStore error = %q, want it to name both the rejected and the supported driver", err.Error())
	}
}

func TestNewStoreBuildsMemoryStore(t *testing.T) {
	for _, driver := range []string{"", "memory"} {
		cfg := &config.Config{Store: config.StoreConfig{Driver: driver}}
		st, err := newStore(cfg)
		if err != nil {
			t.Fatalf("newStore(driver=%q): %v", driver, err)
		}
		if st == nil {
			t.Fatalf("newStore(driver=%q): want a non-nil store", driver)
		}
		st.Close()
	}
}

func TestResolveMirrorPathEmptyDisablesMirror(t *testing.T) {
	if got := resolveMirrorPath(""); got != "" {
		t.Fatalf("resolveMirrorPath(\"\") = %q, want \"\"", got)
	}
}

func TestResolveMirrorPathCreatesDataDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "does", "not", "exist", "yet")
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("precondition: %q already exists", dir)
	}

	got := resolveMirrorPath(dir)
	want := filepath.Join(dir, mirrorStateFile)
	if got != want {
		t.Fatalf("resolveMirrorPath(%q) = %q, want %q", dir, got, want)
	}

	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("data_dir was not created: %v", err)
	}
	if !info.IsDir() {
		t.Fatalf("%q was created but is not a directory", dir)
	}
}

func TestResolveMirrorPathUnwritableParentDisablesMirror(t *testing.T) {
	// A regular file in place of a would-be parent directory makes
	// MkdirAll fail regardless of the test's own user/permissions (e.g.
	// running as root), unlike a plain permission-bit test would.
	blocker := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	dataDir := filepath.Join(blocker, "sub")

	got := resolveMirrorPath(dataDir)
	if got != "" {
		t.Fatalf("resolveMirrorPath(%q) = %q, want \"\" (mkdir must fail, not panic or error out)", dataDir, got)
	}
}
