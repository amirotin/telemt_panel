package update

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"debug/buildinfo"
	"debug/elf"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

var (
	releaseArches   = []string{"x86_64", "aarch64", "armv7", "mipsle", "mips"}
	releaseVariants = []string{"gnu", "musl"}
)

// TestReleaseContract checks actual make release outputs. RELEASE_DIR enables
// this gate; RELEASE_VERSION checks the tag's embedded version. GNU/musl names
// and unprefixed MIPS aliases are transitional, not separate binary builds.
func TestReleaseContract(t *testing.T) {
	dir := os.Getenv("RELEASE_DIR")
	if dir == "" {
		t.Skip("set RELEASE_DIR to make release output and RELEASE_VERSION to its VERSION")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	expected := make(map[string]bool)
	for _, prefix := range []string{"telemt-panel", "telemt-panel-lite"} {
		for _, arch := range releaseArches {
			for _, libc := range releaseVariants {
				name := AssetName(prefix, arch, libc)
				expected[name], expected[name+".sha256"] = true, true
			}
		}
	}
	assets := make([]Asset, 0, len(entries))
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() || !expected[entry.Name()] {
			t.Fatalf("unexpected release entry: %s", entry.Name())
		}
		assets = append(assets, Asset{Name: entry.Name()})
	}
	if len(entries) != len(expected) {
		t.Fatalf("release entries = %d, want %d (20 archives + 20 checksums)", len(entries), len(expected))
	}
	hashes := make(map[string][32]byte)
	for _, prefix := range []string{"telemt-panel", "telemt-panel-lite"} {
		for _, arch := range releaseArches {
			for _, libc := range releaseVariants {
				name := AssetName(prefix, arch, libc)
				t.Run(name, func(t *testing.T) {
					lite := prefix == "telemt-panel-lite" || arch == "mips" || arch == "mipsle"
					matcher := NewAssetMatcher(prefix, arch, libc)
					if prefix == "telemt-panel-lite" {
						matcher = NewPanelAssetMatcher(arch, libc, "lite")
					} else if !lite {
						matcher = NewPanelAssetMatcher(arch, libc, "full")
					}
					bin, sum := matcher(assets)
					if bin == nil || bin.Name != name || sum == nil || sum.Name != name+".sha256" {
						t.Fatal("updater selected the wrong archive or checksum")
					}
					archive := filepath.Join(dir, name)
					digest, err := sha256File(archive)
					if err != nil {
						t.Fatal(err)
					}
					checksum, err := os.ReadFile(archive + ".sha256")
					if err != nil || string(checksum) != digest+"  "+name+"\n" {
						t.Fatal("checksum digest or filename does not match archive")
					}
					content, err := readReleaseBinary(archive)
					if err != nil {
						t.Fatal(err)
					}
					checkReleaseELF(t, content, arch, lite)
					key := arch
					if lite {
						key += "-lite"
					}
					hash := sha256.Sum256(content)
					if previous, ok := hashes[key]; ok && hash != previous {
						t.Fatal("compatibility aliases contain different binaries")
					}
					hashes[key] = hash
					path, err := extractSingleBinary(archive, t.TempDir())
					if err != nil {
						t.Fatal(err)
					}
					extracted, err := os.ReadFile(path)
					if err != nil || !bytes.Equal(content, extracted) {
						t.Fatal("updater extraction changed the binary")
					}
					if runtime.GOOS == "linux" && arch == DetectArch() {
						ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
						defer cancel()
						out, err := exec.CommandContext(ctx, path, "version").Output()
						profile := "full: memory sqlite"
						if lite {
							profile = "lite: memory"
						}
						if err != nil || !strings.Contains(string(out), "("+profile+")") {
							t.Fatalf("native version smoke: %q, %v", out, err)
						}
						if version := os.Getenv("RELEASE_VERSION"); version != "" && !strings.HasPrefix(string(out), "telemt-panel "+version+" (") {
							t.Fatalf("native embedded version mismatch: %q", out)
						}
					}
				})
			}
		}
	}
}

func checkReleaseELF(t *testing.T, content []byte, arch string, lite bool) {
	t.Helper()
	limit := 32 << 20
	if lite {
		limit = 16 << 20
	}
	if len(content) > limit {
		t.Fatalf("binary exceeds profile size limit: %d > %d", len(content), limit)
	}
	f, err := elf.NewFile(bytes.NewReader(content))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	machine := map[string]elf.Machine{"x86_64": elf.EM_X86_64, "aarch64": elf.EM_AARCH64, "armv7": elf.EM_ARM, "mipsle": elf.EM_MIPS, "mips": elf.EM_MIPS}[arch]
	class, data := elf.ELFCLASS32, elf.ELFDATA2LSB
	if arch == "x86_64" || arch == "aarch64" {
		class = elf.ELFCLASS64
	}
	if arch == "mips" {
		data = elf.ELFDATA2MSB
	}
	if f.Machine != machine || f.Class != class || f.Data != data {
		t.Fatalf("wrong ELF target: %s %s %s", f.Machine, f.Class, f.Data)
	}
	for _, program := range f.Progs {
		if program.Type == elf.PT_INTERP || program.Type == elf.PT_DYNAMIC {
			t.Fatal("release binary must be static")
		}
	}
	info, err := buildinfo.Read(bytes.NewReader(content))
	if err != nil {
		t.Fatal(err)
	}
	if info.Path != "github.com/amirotin/telemt_panel/cmd/panel" {
		t.Fatalf("wrong executable package: %s", info.Path)
	}
	settings := make(map[string]string)
	for _, entry := range info.Settings {
		settings[entry.Key] = entry.Value
	}
	if settings["CGO_ENABLED"] != "0" || settings["GOOS"] != "linux" || settings["-trimpath"] != "true" || (settings["-tags"] == "lite") != lite {
		t.Fatal("wrong Go build profile, CGO configuration or trimpath setting")
	}
	if arch == "armv7" && strings.Split(settings["GOARM"], ",")[0] != "7" {
		t.Fatal("ARM build must target ARMv7")
	}
	if (arch == "mips" || arch == "mipsle") && settings["GOMIPS"] != "softfloat" {
		t.Fatal("MIPS build must use softfloat")
	}
	hasSQLite := false
	for _, dependency := range info.Deps {
		hasSQLite = hasSQLite || dependency.Path == "github.com/ncruces/go-sqlite3"
	}
	if hasSQLite == lite {
		t.Fatal("SQLite dependency does not match full/lite profile")
	}
	// -trimpath omits -ldflags from Go build metadata. The linker stores -X
	// string values with a NUL terminator; native builds are also executed above.
	if version := os.Getenv("RELEASE_VERSION"); version != "" && !bytes.Contains(content, append([]byte(version), 0)) {
		t.Fatal("linked release version string is missing")
	}
}

func readReleaseBinary(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return nil, err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	hdr, err := tr.Next()
	if err != nil {
		return nil, err
	}
	if hdr.Typeflag != tar.TypeReg || hdr.Name != "telemt-panel" || hdr.Mode != 0o755 || hdr.Size <= 0 || hdr.Size > 32<<20 || hdr.Uid != 0 || hdr.Gid != 0 {
		return nil, fmt.Errorf("unexpected release member: %s", hdr.Name)
	}
	content, err := io.ReadAll(tr)
	if err != nil {
		return nil, err
	}
	if _, err := tr.Next(); err != io.EOF {
		return nil, fmt.Errorf("extra or malformed release member: %v", err)
	}
	// tar EOF may precede the gzip trailer; consume it to verify CRC and size.
	if _, err := io.Copy(io.Discard, gz); err != nil {
		return nil, err
	}
	return content, nil
}

func TestReleaseArchiveValidationRejectsExtraEntriesAndCorruption(t *testing.T) {
	for _, scenario := range []string{"valid", "extra-directory", "extra-symlink", "wrong-mode", "wrong-name", "truncated-gzip", "bad-crc", "bad-tar-header"} {
		t.Run(scenario, func(t *testing.T) {
			var archive bytes.Buffer
			gz := gzip.NewWriter(&archive)
			tw := tar.NewWriter(gz)
			hdr := &tar.Header{Name: "telemt-panel", Mode: 0o755, Typeflag: tar.TypeReg, Size: 4}
			if scenario == "wrong-mode" {
				hdr.Mode = 0o644
			}
			if scenario == "wrong-name" {
				hdr.Name = "config.toml"
			}
			if err := tw.WriteHeader(hdr); err != nil {
				t.Fatal(err)
			}
			if _, err := tw.Write([]byte("test")); err != nil {
				t.Fatal(err)
			}
			if scenario == "extra-directory" || scenario == "extra-symlink" {
				extra := &tar.Header{Name: "extra", Typeflag: tar.TypeDir}
				if scenario == "extra-symlink" {
					extra.Typeflag, extra.Linkname = tar.TypeSymlink, "telemt-panel"
				}
				if err := tw.WriteHeader(extra); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "bad-tar-header" {
				if err := tw.Flush(); err != nil {
					t.Fatal(err)
				}
				if _, err := gz.Write(bytes.Repeat([]byte("!"), 512)); err != nil {
					t.Fatal(err)
				}
			} else if err := tw.Close(); err != nil {
				t.Fatal(err)
			}
			if err := gz.Close(); err != nil {
				t.Fatal(err)
			}
			data := archive.Bytes()
			if scenario == "truncated-gzip" {
				data = data[:len(data)-4]
			}
			if scenario == "bad-crc" {
				data[len(data)-8] ^= 1
			}
			path := filepath.Join(t.TempDir(), "fixture.tar.gz")
			if err := os.WriteFile(path, data, 0o600); err != nil {
				t.Fatal(err)
			}
			_, err := readReleaseBinary(path)
			if (err == nil) != (scenario == "valid") {
				t.Fatalf("validation error: %v", err)
			}
		})
	}
}
