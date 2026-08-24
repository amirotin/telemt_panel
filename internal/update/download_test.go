package update

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
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
