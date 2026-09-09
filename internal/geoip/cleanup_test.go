package geoip

import (
	"context"
	"encoding/json"
	"errors"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func TestManagerReplacementPreservesUnmarkedPreviousBundle(t *testing.T) {
	m := NewManager(t.TempDir(), newMemorySettings())
	defer m.Close()
	cfg := fileConfig(writeFixture(t, "country"), "", "")
	if _, err := m.PutConfig(cfg); err != nil {
		t.Fatal(err)
	}
	waitState(t, m, StateReady)
	m.mu.RLock()
	old := m.active.dir
	m.mu.RUnlock()
	// A pre-marker installation can still have a valid active manifest.
	if err := os.Remove(filepath.Join(old, ".telemt-panel-geoip.json")); err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	path := filepath.Join(old, "country.mmdb")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.PutConfig(cfg); err != nil {
		t.Fatal(err)
	}
	waitState(t, m, StateReady)
	after, err := os.ReadFile(path)
	if err != nil || string(after) != string(before) {
		t.Fatalf("unmarked previous bundle changed: %v", err)
	}
}

func cleanupFixture(t *testing.T) (*Manager, Config, *bundle) {
	t.Helper()
	m := NewManager(t.TempDir(), newMemorySettings())
	t.Cleanup(m.Close)
	cfg := fileConfig(writeFixture(t, "country"), "", "")
	b, _, err := m.buildBundle(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(b.close)
	return m, cfg, b
}

func ownedFixture(t *testing.T, root, name string) string {
	t.Helper()
	dir := filepath.Join(root, name)
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := writeBundleMarker(dir); err != nil {
		t.Fatal(err)
	}
	putCleanupFile(t, filepath.Join(dir, "country.mmdb"), "keep bytes")
	return dir
}

func putCleanupFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestCleanupOnlyKnownOwnedInactiveDirectories(t *testing.T) {
	for _, scenario := range []string{"staging", "bundle", "unmarked", "unknown-file", "nested", "child-link", "directory-link", "marker-link", "marker-fifo", "bad-owner", "bad-version", "bad-id", "unknown-marker-field", "trailing-marker", "large-marker", "unsafe-directory"} {
		t.Run(scenario, func(t *testing.T) {
			m, cfg, active := cleanupFixture(t)
			root := filepath.Join(m.dataDir, "geoip")
			name := "bundle-orphan"
			if scenario == "staging" {
				name = ".staging-orphan"
			}
			dir := ownedFixture(t, root, name)
			marker := filepath.Join(dir, bundleMarkerName)
			outside := filepath.Join(t.TempDir(), "sentinel")
			putCleanupFile(t, outside, "outside unchanged")
			switch scenario {
			case "unmarked":
				if err := os.Remove(marker); err != nil {
					t.Fatal(err)
				}
			case "unknown-file":
				putCleanupFile(t, filepath.Join(dir, "notes.txt"), "user file")
			case "nested":
				if err := os.Mkdir(filepath.Join(dir, "nested"), 0o700); err != nil {
					t.Fatal(err)
				}
			case "child-link":
				if err := os.Symlink(outside, filepath.Join(dir, "asn.mmdb")); err != nil {
					t.Fatal(err)
				}
			case "directory-link":
				moved := filepath.Join(t.TempDir(), name)
				if err := os.Rename(dir, moved); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(moved, dir); err != nil {
					t.Fatal(err)
				}
			case "marker-link", "marker-fifo":
				if err := os.Remove(marker); err != nil {
					t.Fatal(err)
				}
				if scenario == "marker-link" {
					if err := os.Symlink(outside, marker); err != nil {
						t.Fatal(err)
					}
				} else if err := unix.Mkfifo(marker, 0o600); err != nil {
					t.Fatal(err)
				}
			case "bad-owner":
				putCleanupFile(t, marker, `{"owner":"another","version":1,"id":"orphan"}`)
			case "bad-version":
				putCleanupFile(t, marker, `{"owner":"telemt-panel.geoip","version":2,"id":"orphan"}`)
			case "bad-id":
				putCleanupFile(t, marker, `{"owner":"telemt-panel.geoip","version":1,"id":"other"}`)
			case "unknown-marker-field":
				putCleanupFile(t, marker, `{"owner":"telemt-panel.geoip","version":1,"id":"orphan","extra":1}`)
			case "trailing-marker":
				putCleanupFile(t, marker, `{"owner":"telemt-panel.geoip","version":1,"id":"orphan"} {}`)
			case "large-marker":
				putCleanupFile(t, marker, strings.Repeat(" ", 513))
			case "unsafe-directory":
				if err := os.Chmod(dir, 0o777); err != nil {
					t.Fatal(err)
				}
			}
			if err := cleanupOwnedBundles(root, cfg, active, ""); err != nil {
				t.Fatal(err)
			}
			if scenario == "staging" || scenario == "bundle" {
				if _, err := os.Lstat(dir); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("owned orphan not removed: %v", err)
				}
			} else {
				got, err := os.ReadFile(filepath.Join(dir, "country.mmdb"))
				if err != nil || string(got) != "keep bytes" {
					t.Fatalf("protected data changed: %q, %v", got, err)
				}
			}
			if got, err := os.ReadFile(outside); err != nil || string(got) != "outside unchanged" {
				t.Fatalf("outside sentinel changed: %v", err)
			}
			if got, err := active.lookup(netip.MustParseAddr("81.2.69.142")); err != nil || got.CountryCode != "GB" {
				t.Fatalf("active lookup lost: %+v %v", got, err)
			}
		})
	}
}

func TestCleanupProtectsConfiguredSourcesAndUnsafeRoots(t *testing.T) {
	for _, scenario := range []string{"source-inside", "source-symlink", "source-missing", "source-ambiguous", "hardlink-outside", "unsafe-root", "symlink-root", "unmarked-active"} {
		t.Run(scenario, func(t *testing.T) {
			m, cfg, active := cleanupFixture(t)
			root := filepath.Join(m.dataDir, "geoip")
			dir := ownedFixture(t, root, "bundle-source")
			source := filepath.Join(dir, "country.mmdb")
			switch scenario {
			case "source-inside":
				cfg.ASN.Location = source // Disabled entries still protect their local source.
			case "source-symlink":
				link := filepath.Join(t.TempDir(), "source.mmdb")
				if err := os.Symlink(source, link); err != nil {
					t.Fatal(err)
				}
				cfg.ASN.Location = link
			case "source-missing":
				cfg.ASN.Location = filepath.Join(dir, "missing.mmdb")
			case "source-ambiguous":
				cfg.ASN.Location = dir + "/../bundle-source/country.mmdb"
			case "hardlink-outside":
				link := filepath.Join(t.TempDir(), "source.mmdb")
				if err := os.Link(source, link); err != nil {
					t.Fatal(err)
				}
				cfg.ASN.Location = link
			case "unsafe-root":
				if err := os.Chmod(root, 0o777); err != nil {
					t.Fatal(err)
				}
			case "symlink-root":
				link := filepath.Join(t.TempDir(), "geoip")
				if err := os.Symlink(root, link); err != nil {
					t.Fatal(err)
				}
				root = link
			case "unmarked-active":
				if err := os.Remove(filepath.Join(active.dir, bundleMarkerName)); err != nil {
					t.Fatal(err)
				}
			}
			_ = cleanupOwnedBundles(root, cfg, active, "")
			_, err := os.Stat(dir)
			if scenario == "hardlink-outside" || scenario == "unmarked-active" {
				if !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("safe orphan retained: %v", err)
				}
			} else if err != nil {
				t.Fatalf("protected directory removed: %v", err)
			}
			if scenario == "hardlink-outside" {
				if got, err := os.ReadFile(cfg.ASN.Location); err != nil || string(got) != "keep bytes" {
					t.Fatalf("external hardlink changed: %v", err)
				}
			}
			if _, err := os.Stat(filepath.Join(active.dir, "country.mmdb")); err != nil {
				t.Fatalf("active removed: %v", err)
			}
		})
	}
}

func TestReplacementCleanupIsTargetedAndProtectsItsLocalSource(t *testing.T) {
	for _, localSource := range []bool{false, true} {
		t.Run(map[bool]string{false: "external-source", true: "previous-bundle-source"}[localSource], func(t *testing.T) {
			m := NewManager(t.TempDir(), newMemorySettings())
			defer m.Close()
			cfg := fileConfig(writeFixture(t, "country"), "", "")
			if _, err := m.PutConfig(cfg); err != nil {
				t.Fatal(err)
			}
			waitState(t, m, StateReady)
			m.mu.RLock()
			old := m.active.dir
			m.mu.RUnlock()
			orphan := ownedFixture(t, filepath.Dir(old), ".staging-unrelated")
			if localSource {
				cfg.Country.Location = filepath.Join(old, "country.mmdb")
			}
			if _, err := m.PutConfig(cfg); err != nil {
				t.Fatal(err)
			}
			waitState(t, m, StateReady)
			_, err := os.Stat(old)
			if localSource && err != nil {
				t.Fatalf("configured source removed: %v", err)
			}
			if !localSource && !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("known old generation retained: %v", err)
			}
			if _, err := os.Stat(orphan); err != nil {
				t.Fatalf("update swept unrelated sibling: %v", err)
			}
		})
	}
}

func TestBundleMarkerIsExclusive(t *testing.T) {
	dir := filepath.Join(t.TempDir(), ".staging-marker")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := writeBundleMarker(dir); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, bundleMarkerName)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeBundleMarker(dir); !errors.Is(err, os.ErrExist) {
		t.Fatalf("marker overwritten: %v", err)
	}
	after, err := os.ReadFile(path)
	if err != nil || string(after) != string(before) {
		t.Fatalf("marker changed: %v", err)
	}
}

func TestCleanupWithRelativeDataDirectory(t *testing.T) {
	for _, targeted := range []bool{false, true} {
		t.Run(map[bool]string{false: "startup", true: "replacement"}[targeted], func(t *testing.T) {
			m, cfg, active := cleanupFixture(t)
			root := filepath.Join(m.dataDir, "geoip")
			orphan := ownedFixture(t, root, "bundle-relative")
			cwd, err := os.Getwd()
			if err != nil {
				t.Fatal(err)
			}
			relativeRoot, err := filepath.Rel(cwd, root)
			if err != nil {
				t.Fatal(err)
			}
			metadata := &bundle{dir: filepath.Join(relativeRoot, filepath.Base(active.dir))}
			only := ""
			if targeted {
				only = filepath.Join(relativeRoot, filepath.Base(orphan))
			}
			if err := cleanupOwnedBundles(relativeRoot, cfg, metadata, only); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(orphan); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("relative owned orphan retained: %v", err)
			}
			if _, err := os.Stat(filepath.Join(active.dir, "country.mmdb")); err != nil {
				t.Fatalf("relative active lost: %v", err)
			}
		})
	}
}

func TestRestoreCleanupRequiresVerifiedDurableManifest(t *testing.T) {
	for _, scenario := range []string{"success", "manifest-sync", "root-sync", "disabled", "missing-manifest", "corrupt-manifest", "unreadable-manifest", "symlink-manifest", "invalid-manifest", "corrupt-database", "bad-settings", "unmarked-active"} {
		t.Run(scenario, func(t *testing.T) {
			m, cfg, active := cleanupFixture(t)
			root := filepath.Join(m.dataDir, "geoip")
			orphan := ownedFixture(t, root, ".staging-abandoned")
			active.close()
			switch scenario {
			case "disabled":
				cfg.Enabled = false
			case "missing-manifest":
				if err := os.Remove(filepath.Join(root, "active.json")); err != nil {
					t.Fatal(err)
				}
			case "corrupt-manifest":
				putCleanupFile(t, filepath.Join(root, "active.json"), "{")
			case "unreadable-manifest":
				if os.Geteuid() == 0 {
					t.Skip("root bypasses read permissions")
				}
				if err := os.Chmod(filepath.Join(root, "active.json"), 0); err != nil {
					t.Fatal(err)
				}
			case "symlink-manifest":
				path := filepath.Join(root, "active.json")
				outside := filepath.Join(t.TempDir(), "active.json")
				if err := os.Rename(path, outside); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, path); err != nil {
					t.Fatal(err)
				}
			case "invalid-manifest":
				putCleanupFile(t, filepath.Join(root, "active.json"), `{}`)
			case "corrupt-database":
				if err := os.Chmod(filepath.Join(active.dir, "country.mmdb"), 0o600); err != nil {
					t.Fatal(err)
				}
				putCleanupFile(t, filepath.Join(active.dir, "country.mmdb"), "broken database")
			case "unmarked-active":
				if err := os.Remove(filepath.Join(active.dir, bundleMarkerName)); err != nil {
					t.Fatal(err)
				}
			}
			raw, err := json.Marshal(cfg)
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "bad-settings" {
				raw = []byte(`{"unknown":1}`)
			}
			if err := m.store.SetSetting(configSettingKey, string(raw)); err != nil {
				t.Fatal(err)
			}
			var synced []string
			m.syncFile = func(path string) error {
				synced = append(synced, "file")
				if scenario == "manifest-sync" {
					return errors.New("injected file sync failure")
				}
				return syncDatabaseFile(path)
			}
			m.syncDir = func(path string) error {
				synced = append(synced, "directory")
				if scenario == "root-sync" {
					return errors.New("injected directory sync failure")
				}
				return syncDatabaseFile(path)
			}
			// Isolated initialized manager, with no operation running: inject only
			// the existing sync hooks before restoration, not constructor options.
			m.restore()
			_, err = os.Stat(orphan)
			success := scenario == "success" || scenario == "unmarked-active"
			if success && !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("owned orphan remains after barrier: %v", err)
			}
			if !success && err != nil {
				t.Fatalf("orphan removed without barrier: %v", err)
			}
			if success || scenario == "manifest-sync" || scenario == "root-sync" {
				if got := m.Lookup("81.2.69.142"); got == nil || got.CountryCode != "GB" {
					t.Fatalf("verified lookup lost: %+v", got)
				}
				want := "file,directory"
				if scenario == "manifest-sync" {
					want = "file"
				}
				if strings.Join(synced, ",") != want {
					t.Fatalf("barrier order = %v", synced)
				}
			} else if len(synced) != 0 {
				t.Fatalf("unverified/disabled restore synced: %v", synced)
			}
		})
	}
}
