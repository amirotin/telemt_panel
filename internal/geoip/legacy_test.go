package geoip

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestImportLegacyGeoIPDetectsKindAndRestoresBundle(t *testing.T) {
	for _, kind := range []string{"country", "city"} {
		t.Run(kind, func(t *testing.T) {
			dataDir := t.TempDir()
			settings := newMemorySettings()
			path, asn := writeFixture(t, kind), writeFixture(t, "asn")
			before, _ := os.ReadFile(path)
			imported, err := ImportLegacyFiles(dataDir, settings, path, asn)
			if err != nil || !imported {
				t.Fatalf("import=%v err=%v", imported, err)
			}
			after, _ := os.ReadFile(path)
			if !bytes.Equal(before, after) {
				t.Fatal("source database changed")
			}
			manager := NewManager(dataDir, settings)
			defer manager.Close()
			cfg := manager.Settings().Config
			if cfg.Source != SourceFiles || cfg.Schedule != ScheduleManual || cfg.City.Enabled != (kind == "city") || cfg.Country.Enabled != (kind == "country") || !cfg.ASN.Enabled {
				t.Fatal("incorrect imported file configuration")
			}
			got := manager.Lookup("81.2.69.142")
			if !manager.Status().Available || got == nil || got.CountryCode != "GB" || (kind == "city" && got.City != "London") {
				t.Fatalf("restored lookup failed: %+v", got)
			}
			cfg.Enabled = false
			if _, err := manager.PutConfig(cfg); err != nil {
				t.Fatal(err)
			}
			original, _, _ := settings.GetSetting(configSettingKey)
			if imported, err := ImportLegacyFiles(dataDir, settings, "/now/missing", asn); err != nil || imported {
				t.Fatal("existing administrator settings were not respected")
			}
			current, _, _ := settings.GetSetting(configSettingKey)
			if current != original {
				t.Fatal("disabled GeoIP changed")
			}
		})
	}
}

func TestImportLegacyGeoIPRejectsUnsafeSourcesAndWrongTypes(t *testing.T) {
	dir := t.TempDir()
	fifo := filepath.Join(dir, "pipe")
	if err := unix.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	corrupt := filepath.Join(dir, "bad.mmdb")
	if err := os.WriteFile(corrupt, []byte("invalid"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, paths := range [][2]string{
		{fifo, ""}, {dir, ""}, {corrupt, ""}, {filepath.Join(dir, "missing"), ""},
		{writeFixture(t, "asn"), ""}, {"", writeFixture(t, "country")},
		{writeFixture(t, "wrong-country"), ""},
	} {
		dataDir := t.TempDir()
		settings := newMemorySettings()
		if imported, err := ImportLegacyFiles(dataDir, settings, paths[0], paths[1]); err == nil || imported {
			t.Fatal("invalid input activated")
		}
		if _, exists, _ := settings.GetSetting(configSettingKey); exists {
			t.Fatal("failed activation saved configuration")
		}
		entries, _ := os.ReadDir(dataDir)
		for _, entry := range entries {
			if entry.Name() != "geoip" {
				t.Fatal("inspection files leaked")
			}
		}
	}
}

func TestImportLegacyGeoIPRetriesAfterSettingsWriteFailure(t *testing.T) {
	dir := t.TempDir()
	settings := newMemorySettings()
	settings.setErr = errors.New("injected write failure")
	path := writeFixture(t, "country")
	if imported, err := ImportLegacyFiles(dir, settings, path, ""); err == nil || imported {
		t.Fatal("settings failure ignored")
	}
	settings.setErr = nil
	if imported, err := ImportLegacyFiles(dir, settings, path, ""); err != nil || !imported {
		t.Fatal("retry failed")
	}
	manager := NewManager(dir, settings)
	defer manager.Close()
	if !manager.Status().Available {
		t.Fatal("retried bundle not active")
	}
}
