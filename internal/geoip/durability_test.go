package geoip

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestManagerDirectorySyncFailurePreservesRecoverableBundles(t *testing.T) {
	for _, phase := range []string{"bundle", "bundle-parent", "manifest"} {
		t.Run(phase, func(t *testing.T) {
			dataDir := t.TempDir()
			root := filepath.Join(dataDir, "geoip")
			settings := newMemorySettings()
			manager := NewManager(dataDir, settings)
			defer manager.Close()
			if _, err := manager.PutConfig(fileConfig(writeFixture(t, "country"), "", "")); err != nil {
				t.Fatal(err)
			}
			waitState(t, manager, StateReady)
			oldManifest, err := os.ReadFile(filepath.Join(root, "active.json"))
			if err != nil {
				t.Fatal(err)
			}
			old, err := readManifest(root)
			if err != nil {
				t.Fatal(err)
			}
			manager.syncDir = func(path string) error {
				current, err := readManifest(root)
				if err != nil {
					return err
				}
				if (phase == "bundle" && strings.HasPrefix(filepath.Base(path), ".staging-")) ||
					(phase == "bundle-parent" && path == root && current.Directory == old.Directory) ||
					(phase == "manifest" && path == root && current.Directory != old.Directory) {
					return errors.New("injected directory sync failure")
				}
				return syncDatabaseFile(path)
			}
			if _, err := manager.PutConfig(fileConfig(writeFixture(t, "optional-country"), "", "")); err != nil {
				t.Fatal(err)
			}
			status := waitState(t, manager, StateError)
			if !status.Available || status.LastError == nil || *status.LastError != ErrorActivationFailed {
				t.Fatalf("sync failure status: %+v", status)
			}
			if got := manager.Lookup("81.2.69.142"); got == nil || got.CountryCode != "GB" || got.CountryName == "" {
				t.Fatalf("old in-memory generation lost: %+v", got)
			}
			manager.Close()
			current, err := readManifest(root)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(filepath.Join(root, current.Directory, "country.mmdb")); err != nil {
				t.Fatalf("manifest references deleted generation: %v", err)
			}
			if _, err := os.Stat(filepath.Join(root, old.Directory, "country.mmdb")); err != nil {
				t.Fatalf("old recoverable generation removed: %v", err)
			}
			restored := NewManager(dataDir, settings)
			if got := restored.Lookup("81.2.69.142"); got == nil || got.CountryCode != "GB" {
				t.Fatalf("restart lookup lost: %+v", got)
			}
			restored.Close()
			if phase != "manifest" && current.Directory != old.Directory {
				t.Fatal("manifest changed before bundle became durable")
			}
			if phase == "manifest" {
				if current.Directory == old.Directory {
					t.Fatal("post-rename failure was not exercised")
				}
				// A crash may retain the old manifest when the replacement rename
				// was not synced. Both possible manifest generations must work.
				if err := os.WriteFile(filepath.Join(root, "active.json"), oldManifest, 0o600); err != nil {
					t.Fatal(err)
				}
				recovered := NewManager(dataDir, settings)
				defer recovered.Close()
				if got := recovered.Lookup("81.2.69.142"); got == nil || got.CountryCode != "GB" || got.CountryName == "" {
					t.Fatalf("old manifest recovery failed: %+v", got)
				}
			}
		})
	}
}
