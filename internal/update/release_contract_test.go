package update

import (
	"archive/tar"
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// releaseArches/releaseVariants mirror the Makefile's release target
// (P1.2): every arch the Makefile cross-compiles, and both libc variant
// names it packages the (variant-independent, pure-Go) binary under.
var (
	releaseArches   = []string{"x86_64", "aarch64", "armv7", "mipsle", "mips"}
	releaseVariants = []string{"gnu", "musl"}
)

// TestReleaseContract proves the producer (Makefile's release target) and
// consumer (NewAssetMatcher + extractSingleBinary) actually agree, closing
// the audit gap (P1.2) where they were never exercised together: a real
// release built by `make release` must be installable by the self-updater.
//
// Skipped unless RELEASE_DIR points at a directory populated by
// `make release` (see .github/workflows/ci.yml's release-contract job and
// task-3-report.md for the exact invocation).
func TestReleaseContract(t *testing.T) {
	dir := os.Getenv("RELEASE_DIR")
	if dir == "" {
		t.Skip("RELEASE_DIR not set; run `make release` and set RELEASE_DIR=$PWD/release to exercise this test")
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read RELEASE_DIR %q: %v", dir, err)
	}
	assets := make([]Asset, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		assets = append(assets, Asset{Name: e.Name()})
	}

	for _, arch := range releaseArches {
		for _, variant := range releaseVariants {
			t.Run(arch+"-"+variant, func(t *testing.T) {
				match := NewAssetMatcher("telemt-panel", arch, variant)
				bin, sum := match(assets)
				if bin == nil {
					t.Fatalf("no tarball matched for arch=%q variant=%q among %d assets", arch, variant, len(assets))
				}
				wantBin := AssetName("telemt-panel", arch, variant)
				if bin.Name != wantBin {
					t.Fatalf("matched binary = %q, want %q", bin.Name, wantBin)
				}
				if sum == nil {
					t.Fatalf("no checksum matched for %q", bin.Name)
				}
				wantSum := wantBin + ".sha256"
				if sum.Name != wantSum {
					t.Fatalf("matched checksum = %q, want %q", sum.Name, wantSum)
				}

				tarPath := filepath.Join(dir, bin.Name)
				sumPath := filepath.Join(dir, sum.Name)

				digest, err := sha256File(tarPath)
				if err != nil {
					t.Fatalf("hash %q: %v", tarPath, err)
				}
				sumContent, err := os.ReadFile(sumPath)
				if err != nil {
					t.Fatalf("read %q: %v", sumPath, err)
				}
				want := parseChecksumFile(string(sumContent))
				if want == "" {
					t.Fatalf("%q has no parseable checksum", sumPath)
				}
				if digest != want {
					t.Fatalf("%q sha256 = %s, checksum file says %s", tarPath, digest, want)
				}

				name, content := onlyTarEntry(t, tarPath)
				if name != "telemt-panel" {
					t.Fatalf("tarball %q's single entry is named %q, want \"telemt-panel\"", bin.Name, name)
				}
				if len(content) == 0 {
					t.Fatalf("tarball %q's telemt-panel entry is empty", bin.Name)
				}
			})
		}
	}
}

// onlyTarEntry reads tarGzPath and returns the name and content of its one
// regular-file entry, failing the test if there is not exactly one.
func onlyTarEntry(t *testing.T, tarGzPath string) (string, []byte) {
	t.Helper()
	f, err := os.Open(tarGzPath)
	if err != nil {
		t.Fatalf("open %q: %v", tarGzPath, err)
	}
	defer f.Close()

	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatalf("gzip %q: %v", tarGzPath, err)
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	var name string
	var content []byte
	found := false
	for {
		hdr, err := tr.Next()
		if err != nil {
			break // io.EOF or a real error; the found/count checks below catch a truncated archive
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		if found {
			t.Fatalf("tarball %q contains more than one regular file", tarGzPath)
		}
		found = true
		name = hdr.Name
		buf, err := io.ReadAll(tr)
		if err != nil {
			t.Fatalf("read entry %q in %q: %v", hdr.Name, tarGzPath, err)
		}
		content = buf
	}
	if !found {
		t.Fatalf("tarball %q contains no regular file", tarGzPath)
	}
	return name, content
}
