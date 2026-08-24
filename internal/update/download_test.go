package update

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"os"
	"path/filepath"
	"testing"
)

// buildTarGzRaw builds a tar.gz from arbitrary entries, for tests that need
// entry names buildTarGz can't express (path traversal, multiple files).
func buildTarGzRaw(t *testing.T, entries []struct {
	name    string
	content []byte
	typ     byte
}) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		typ := e.typ
		if typ == 0 {
			typ = tar.TypeReg
		}
		if err := tw.WriteHeader(&tar.Header{Name: e.name, Mode: 0o755, Size: int64(len(e.content)), Typeflag: typ}); err != nil {
			t.Fatalf("tar header %q: %v", e.name, err)
		}
		if _, err := tw.Write(e.content); err != nil {
			t.Fatalf("tar write %q: %v", e.name, err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("tar close: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	return buf.Bytes()
}

func TestExtractSingleBinary_RejectsPathTraversal(t *testing.T) {
	tests := []string{"../evil", "a/../../evil", "/etc/passwd", "dir/../../../escape"}
	for _, name := range tests {
		t.Run(name, func(t *testing.T) {
			data := buildTarGzRaw(t, []struct {
				name    string
				content []byte
				typ     byte
			}{{name: name, content: []byte("payload")}})

			dir := t.TempDir()
			tarPath := filepath.Join(dir, "release.tar.gz")
			if err := os.WriteFile(tarPath, data, 0o644); err != nil {
				t.Fatalf("write fixture: %v", err)
			}

			if _, err := extractSingleBinary(tarPath, dir); err == nil {
				t.Errorf("extractSingleBinary(%q): want error, got nil", name)
			}
		})
	}
}

func TestExtractSingleBinary_RejectsMultipleRegularFiles(t *testing.T) {
	data := buildTarGzRaw(t, []struct {
		name    string
		content []byte
		typ     byte
	}{
		{name: "telemt", content: []byte("bin1")},
		{name: "extra", content: []byte("bin2")},
	})
	dir := t.TempDir()
	tarPath := filepath.Join(dir, "release.tar.gz")
	os.WriteFile(tarPath, data, 0o644)

	if _, err := extractSingleBinary(tarPath, dir); err == nil {
		t.Error("extractSingleBinary: want error for two regular files, got nil")
	}
}

func TestExtractSingleBinary_ExtractsTheOneFile(t *testing.T) {
	dir := t.TempDir()
	tarPath := filepath.Join(dir, "release.tar.gz")
	data := buildTarGz(t, "telemt", []byte("binary-content"))
	os.WriteFile(tarPath, data, 0o644)

	path, err := extractSingleBinary(tarPath, dir)
	if err != nil {
		t.Fatalf("extractSingleBinary: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read extracted: %v", err)
	}
	if string(got) != "binary-content" {
		t.Errorf("extracted content = %q, want %q", got, "binary-content")
	}
}

func TestParseChecksumFile(t *testing.T) {
	tests := []struct {
		content string
		want    string
	}{
		{"deadbeef\n", "deadbeef"},
		{"DEADBEEF  telemt.tar.gz\n", "deadbeef"},
		{"", ""},
		{"   \n", ""},
	}
	for _, tc := range tests {
		if got := parseChecksumFile(tc.content); got != tc.want {
			t.Errorf("parseChecksumFile(%q) = %q, want %q", tc.content, got, tc.want)
		}
	}
}

// TestLatestVersion_SkipsPrereleasesPickingLatestStable covers finding 5:
// LatestVersion (the auto-update "apply"/"check" picker) must never
// auto-offer a prerelease while a newer stable release also exists.
func TestLatestVersion_SkipsPrereleasesPickingLatestStable(t *testing.T) {
	fixture := newFakeReleaseServer(t)
	assetName := AssetName(assetBaseName(TargetTelemt), "x86_64", "musl")
	url := fixture.addAsset(assetName, []byte("x"))
	fixture.releases = []Release{
		{Tag: "v1.9.0", Assets: []Asset{{Name: assetName, BrowserDownloadURL: url}}},
		{Tag: "v2.0.0-rc1", Prerelease: true, Assets: []Asset{{Name: assetName, BrowserDownloadURL: url}}},
	}

	target := &fakeTarget{name: TargetTelemt, repo: "owner/repo", version: "v1.0.0"}
	e, _ := newTestEngine(t, fixture, newTestRunner(), map[string]Target{TargetTelemt: target}, nil)

	version, ok, err := e.LatestVersion(context.Background(), TargetTelemt)
	if err != nil {
		t.Fatalf("LatestVersion: %v", err)
	}
	if !ok || version != "v1.9.0" {
		t.Errorf("LatestVersion = (%q, %v), want (v1.9.0, true) — must skip the newer prerelease and pick the newer stable release", version, ok)
	}
}

// TestLatestVersion_OnlyPrereleaseNewer_PicksNothing covers the other half
// of finding 5: when the only newer release is a prerelease, auto-update
// must find nothing to apply rather than falling back to it.
func TestLatestVersion_OnlyPrereleaseNewer_PicksNothing(t *testing.T) {
	fixture := newFakeReleaseServer(t)
	assetName := AssetName(assetBaseName(TargetTelemt), "x86_64", "musl")
	url := fixture.addAsset(assetName, []byte("x"))
	fixture.releases = []Release{
		{Tag: "v2.0.0-rc1", Prerelease: true, Assets: []Asset{{Name: assetName, BrowserDownloadURL: url}}},
	}

	target := &fakeTarget{name: TargetTelemt, repo: "owner/repo", version: "v1.0.0"}
	e, _ := newTestEngine(t, fixture, newTestRunner(), map[string]Target{TargetTelemt: target}, nil)

	version, ok, err := e.LatestVersion(context.Background(), TargetTelemt)
	if err != nil {
		t.Fatalf("LatestVersion: %v", err)
	}
	if ok {
		t.Errorf("LatestVersion = (%q, true), want ok=false — the only newer release is a prerelease, auto-update must not pick it", version)
	}
}

// TestReleasesView_StillListsPrereleasesForManualApply proves finding 5's
// fix is scoped to LatestVersion only: the manual-apply release list
// (GET /api/updates, backed by ReleasesView) must keep showing a
// prerelease so an operator can still choose to install an RC explicitly.
func TestReleasesView_StillListsPrereleasesForManualApply(t *testing.T) {
	fixture := newFakeReleaseServer(t)
	assetName := AssetName(assetBaseName(TargetTelemt), "x86_64", "musl")
	url := fixture.addAsset(assetName, []byte("x"))
	fixture.releases = []Release{
		{Tag: "v2.0.0-rc1", Prerelease: true, Assets: []Asset{{Name: assetName, BrowserDownloadURL: url}}},
	}

	target := &fakeTarget{name: TargetTelemt, repo: "owner/repo", version: "v1.0.0"}
	e, _ := newTestEngine(t, fixture, newTestRunner(), map[string]Target{TargetTelemt: target}, nil)

	view, err := e.ReleasesView(context.Background(), TargetTelemt)
	if err != nil {
		t.Fatalf("ReleasesView: %v", err)
	}
	found := false
	for _, r := range view.Releases {
		if r.Version == "v2.0.0-rc1" {
			found = true
		}
	}
	if !found {
		t.Error("ReleasesView dropped the prerelease — manual apply's release list must still show it")
	}
}
