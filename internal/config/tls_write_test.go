package config

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

const transportFixture = `# Preserve unrelated values, including omitted defaults.
listen = "127.0.0.1:8080"
base_path = "/admin"
data_dir = ""
[telemt]
url = "http://127.0.0.1:9900"
auth_header = "Bearer sentinel"
[auth]
username = "admin"
password_hash = "private sentinel"
`

func TestTLSFileAtomicPreservationAndRevision(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte(transportFixture), 0644); err != nil {
		t.Fatal(err)
	}
	f, err := OpenTLSFile(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	snapshot, err := f.Read()
	if err != nil {
		t.Fatal(err)
	}
	candidate := TLSCandidate{Listen: "127.0.0.1:8443", TLS: TLSConfig{Mode: "http"}}
	if err := f.Save(snapshot.Revision, candidate); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Listen != "127.0.0.1:8443" || cfg.Telemt.AuthHeader != "Bearer sentinel" || cfg.Auth.PasswordHash != "private sentinel" || cfg.BasePath != "/admin" || cfg.DataDir != "" {
		t.Fatalf("unrelated values changed: %+v", cfg)
	}
	backup, _ := os.ReadFile(path + ".bak")
	if !bytes.Equal(backup, []byte(transportFixture)) {
		t.Fatal("backup must contain exact original bytes")
	}
	for _, name := range []string{path, path + ".bak"} {
		info, _ := os.Stat(name)
		if info.Mode().Perm() != 0600 {
			t.Fatalf("insecure mode: %s %v", name, info.Mode())
		}
	}
	if err := f.Save(snapshot.Revision, candidate); !errors.Is(err, ErrTLSRevision) {
		t.Fatalf("stale save: %v", err)
	}
}

func TestTLSFileRejectsSymlinkAndExternalEdit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	_ = os.WriteFile(path, []byte(transportFixture), 0600)
	link := filepath.Join(dir, "linked.toml")
	_ = os.Symlink(path, link)
	if f, err := OpenTLSFile(link); err == nil {
		f.Close()
		t.Fatal("symlink accepted")
	}
	f, err := OpenTLSFile(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	snapshot, err := f.Read()
	if err != nil {
		t.Fatal(err)
	}
	changed := []byte(transportFixture + "\n# External edit\n")
	_ = os.WriteFile(path, changed, 0600)
	if err := f.Save(snapshot.Revision, TLSCandidate{Listen: "127.0.0.1:9000", TLS: TLSConfig{Mode: "http"}}); !errors.Is(err, ErrTLSRevision) {
		t.Fatalf("external change accepted: %v", err)
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(after, changed) {
		t.Fatal("external edit overwritten")
	}
}

func TestTLSCandidateRejectsNonNumericAndUnsafeListen(t *testing.T) {
	for _, listen := range []string{"127.0.0.1:+80", "127.0.0.1:0", "127.0.0.1:65536", "127.0.0.1:http", "https://panel.example:8443", "bad host:8443", "127.0.0.1:8443 ", "127.0.0.1:-1"} {
		candidate := TLSCandidate{Listen: listen, TLS: TLSConfig{Mode: "http"}}
		if candidate.Normalize("") == nil {
			t.Errorf("invalid listener accepted: %q", listen)
		}
	}
}
