package geoip

import (
	"context"
	"errors"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/oschwald/maxminddb-golang/v2"
)

func trackBundleOpens(m *Manager) *[]*bundle {
	var opened []*bundle
	m.openBundle = func(paths map[Kind]string, at int64) (*bundle, error) {
		b, err := openBundle(paths, at)
		if b != nil {
			opened = append(opened, b)
		}
		return b, err
	}
	return &opened
}

func assertNoMappedBundle(t *testing.T, directory string) {
	t.Helper()
	maps, err := os.ReadFile("/proc/self/maps")
	if err != nil {
		t.Skip("mmap lifecycle inspection requires procfs")
	}
	if strings.Contains(string(maps), directory+"/") {
		t.Fatalf("database mapping still owned under %s", directory)
	}
}

func TestBuildBundlePartialValidationReleasesMappings(t *testing.T) {
	m := NewManager(t.TempDir(), newMemorySettings())
	defer m.Close()
	// Country succeeds; the second reader opens and verifies but fails its type check.
	cfg := fileConfig(writeFixture(t, "country"), writeFixture(t, "country"), "")
	for range 3 {
		b, _, err := m.buildBundle(context.Background(), cfg)
		if b != nil || errorCode(err) != ErrorDatabaseType {
			t.Fatalf("partial validation = %p, %v", b, err)
		}
		assertNoMappedBundle(t, m.dataDir)
		entries, err := os.ReadDir(filepath.Join(m.dataDir, "geoip"))
		if err != nil || len(entries) != 0 {
			t.Fatalf("partial bundle left on disk: %v, %v", entries, err)
		}
	}
}

func TestBuildBundleTransfersVerifiedReadersAcrossRename(t *testing.T) {
	m := NewManager(t.TempDir(), newMemorySettings())
	defer m.Close()
	var opened []*bundle
	verified := make(map[string]int)
	m.openBundle = func(paths map[Kind]string, at int64) (*bundle, error) {
		b, err := openBundleWithVerifier(paths, at, func(r *maxminddb.Reader) error {
			verified[r.Metadata.DatabaseType]++
			return r.Verify()
		})
		opened = append(opened, b)
		return b, err
	}
	cfg := fileConfig(writeFixture(t, "country"), writeFixture(t, "asn"), writeFixture(t, "city"))
	b, _, err := m.buildBundle(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer b.close()
	if len(opened) != 1 || b != opened[0] {
		t.Fatalf("verification passes = %d; returned bundle must be the first verified bundle", len(opened))
	}
	if len(verified) != 3 {
		t.Fatalf("verified database types = %v", verified)
	}
	for kind, count := range verified {
		if count != 1 {
			t.Fatalf("%s Verify calls = %d", kind, count)
		}
	}
	if len(b.databases) != 3 || !strings.HasPrefix(filepath.Base(b.dir), "bundle-") {
		t.Fatalf("transferred bundle = %+v", b)
	}
	for _, raw := range []string{"81.2.69.142", "::ffff:81.2.69.142", "2001:218::1", "1.0.0.1"} {
		got, err := b.lookup(netip.MustParseAddr(raw))
		if err != nil || got.State != ResultFound {
			t.Fatalf("lookup after rename %s: %+v, %v", raw, got, err)
		}
	}
	restored, matches, err := restoreActiveBundle(filepath.Dir(b.dir), cfg)
	if err != nil || !matches {
		t.Fatalf("restore = %v, %v", matches, err)
	}
	restored.close()
}

func TestBuildBundleClosesUntransferredReaders(t *testing.T) {
	for _, phase := range []string{"staging-sync", "rename", "parent-sync", "cancel-staging", "cancel-parent", "manifest", "published"} {
		t.Run(phase, func(t *testing.T) {
			m := NewManager(t.TempDir(), newMemorySettings())
			defer m.Close()
			opened := trackBundleOpens(m)
			root := filepath.Join(m.dataDir, "geoip")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var candidate string
			m.syncDir = func(path string) error {
				if strings.HasPrefix(filepath.Base(path), ".staging-") {
					candidate = filepath.Join(root, "bundle-"+strings.TrimPrefix(filepath.Base(path), ".staging-"))
					switch phase {
					case "staging-sync":
						return errors.New("staging sync failed")
					case "cancel-staging":
						cancel()
					case "rename":
						if err := os.WriteFile(candidate, []byte("unrelated collision"), 0o600); err != nil {
							return err
						}
					}
				}
				if path == root {
					_, err := readManifest(root)
					published := err == nil
					switch {
					case phase == "parent-sync":
						return errors.New("parent sync failed")
					case phase == "cancel-parent":
						cancel()
					case phase == "manifest":
						return os.Mkdir(filepath.Join(root, "active.json"), 0o700)
					case phase == "published" && published:
						return errors.New("manifest directory sync failed")
					}
				}
				return syncDatabaseFile(path)
			}
			b, _, err := m.buildBundle(ctx, fileConfig(writeFixture(t, "country"), "", ""))
			if b != nil || err == nil || len(*opened) == 0 {
				t.Fatalf("build = %p, %v, opens=%d", b, err, len(*opened))
			}
			for _, b := range *opened {
				if b.databases != nil {
					t.Fatal("untransferred readers left open")
				}
			}
			assertNoMappedBundle(t, m.dataDir)
			entries, err := os.ReadDir(root)
			if err != nil {
				t.Fatal(err)
			}
			for _, entry := range entries {
				if strings.HasPrefix(entry.Name(), ".staging-") || strings.HasPrefix(entry.Name(), ".active-") {
					t.Fatalf("unpublished temporary entry retained: %s", entry.Name())
				}
			}
			_, statErr := os.Stat(candidate)
			if phase == "published" || phase == "rename" {
				if statErr != nil {
					t.Fatalf("published candidate or unrelated collision removed: %v", statErr)
				}
			} else if !errors.Is(statErr, os.ErrNotExist) {
				t.Fatalf("unpublished candidate retained: %v", statErr)
			}
		})
	}
}

func TestManagerCloseAfterPublicationClosesCandidate(t *testing.T) {
	m := NewManager(t.TempDir(), newMemorySettings())
	opened := trackBundleOpens(m)
	root := filepath.Join(m.dataDir, "geoip")
	published := make(chan struct{})
	release := make(chan struct{})
	defer m.Close()
	defer close(release)
	m.syncDir = func(path string) error {
		if err := syncDatabaseFile(path); err != nil {
			return err
		}
		if path == root {
			if _, err := readManifest(root); err == nil {
				close(published)
				<-release
			}
		}
		return nil
	}
	if _, err := m.PutConfig(fileConfig(writeFixture(t, "country"), "", "")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-published:
	case <-time.After(3 * time.Second):
		t.Fatal("publication not reached")
	}
	done := make(chan struct{})
	go func() { m.Close(); close(done) }()
	select {
	case <-m.ctx.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("Close did not cancel operation")
	}
	release <- struct{}{}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Close did not finish")
	}
	if m.active != nil || len(*opened) != 1 || (*opened)[0].databases != nil {
		t.Fatal("candidate was not closed after publication")
	}
	assertNoMappedBundle(t, m.dataDir)
	manifest, err := readManifest(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, manifest.Directory, "country.mmdb")); err != nil {
		t.Fatalf("published bundle lost: %v", err)
	}
}

func TestVerifiedBundleFixtureTiming(t *testing.T) {
	if os.Getenv("RUN_GEOIP_VERIFY_TIMING") != "1" {
		t.Skip("opt-in synthetic verification measurement")
	}
	paths := map[Kind]string{
		KindCountry: writeFixture(t, "country"),
		KindASN:     writeFixture(t, "asn"),
		KindCity:    writeFixture(t, "city"),
	}
	var size int64
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		size += info.Size()
	}
	for _, passes := range []int{1, 2} {
		start := time.Now()
		for range 50 {
			for range passes {
				b, err := openBundle(paths, time.Now().Unix())
				if err != nil {
					t.Fatal(err)
				}
				b.close()
			}
		}
		t.Logf("synthetic bytes=%d passes/update=%d updates=50 elapsed=%s", size, passes, time.Since(start))
	}
}
