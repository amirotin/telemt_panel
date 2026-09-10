package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/amirotin/telemt_panel/internal/config"
	"golang.org/x/crypto/bcrypt"
)

func TestConfigCommandsAreOfflineAndReadOnly(t *testing.T) {
	hash, err := bcrypt.GenerateFromPassword([]byte("PRIVATE_PASSWORD"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	for _, legacy := range []bool{false, true} {
		t.Run(fmt.Sprintf("legacy=%v", legacy), func(t *testing.T) {
			dir := t.TempDir()
			dataDir := filepath.Join(dir, "unopened-state")
			raw := fmt.Sprintf("data_dir = %q\n[auth]\nusername = 'operator'\npassword_hash = '%s'\n", dataDir, hash)
			if legacy {
				raw += "jwt_secret = 'PRIVATE_JWT'\n"
			}
			raw += "[telemt]\nurl = 'http://unreachable.invalid:1/PRIVATE_URL'\nauth_header = 'PRIVATE_HEADER'\n"
			if legacy {
				raw += "[panel]\ngithub_token='PRIVATE_GITHUB'\n[geoip]\ndb_path='/nonexistent/city.mmdb'\n"
			} else {
				raw += "[updates]\ngithub_token='PRIVATE_GITHUB'\n"
			}
			raw += "[tls]\ncert_file='/nonexistent/cert.pem'\nkey_file='/nonexistent/key.pem'\n"
			path := filepath.Join(dir, "config.toml")
			if err := os.WriteFile(path, []byte(raw), 0400); err != nil {
				t.Fatal(err)
			}
			for _, command := range []string{"inspect", "check"} {
				var out bytes.Buffer
				if err := runConfigCommand([]string{command, "--config", path}, &out); err != nil {
					t.Fatal(err)
				}
				if strings.Contains(out.String(), "PRIVATE") || strings.Contains(out.String(), string(hash)) {
					t.Fatal("output leaked secrets")
				}
				if command == "inspect" {
					var report config.SourceReport
					if err := json.Unmarshal(out.Bytes(), &report); err != nil {
						t.Fatal(err)
					}
					if report.RequiresMigration != legacy || !report.HasGithubToken || !report.HasTelemtAuth || report.TLSMode != "certificate" {
						t.Fatalf("unexpected report: %+v", report)
					}
				} else if legacy && !strings.Contains(out.String(), "migration required") {
					t.Fatal("legacy check did not explain startup limitation")
				}
			}
			after, err := os.ReadFile(path)
			if err != nil || string(after) != raw {
				t.Fatal("source changed")
			}
			entries, err := os.ReadDir(dir)
			if err != nil || len(entries) != 1 {
				t.Fatal("offline command created state or auxiliary files")
			}
			if legacy {
				if _, err := config.Load(path); err == nil {
					t.Fatal("normal startup must stay strict until state import exists")
				}
			}
		})
	}
}

func TestConfigCommandRejectsUnsafeInputs(t *testing.T) {
	dir := t.TempDir()
	fifo := filepath.Join(dir, "pipe")
	if err := syscall.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	oversized := filepath.Join(dir, "oversized.toml")
	if err := os.WriteFile(oversized, bytes.Repeat([]byte(" "), (1<<20)+1), 0600); err != nil {
		t.Fatal(err)
	}
	malformed := filepath.Join(dir, "malformed.toml")
	if err := os.WriteFile(malformed, []byte("password_hash='PRIVATE_UNTERMINATED\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		nil, {"PRIVATE_UNKNOWN"}, {"inspect", "--PRIVATE_UNKNOWN"},
		{"inspect", "--format", "PRIVATE_FORMAT"}, {"inspect", "--config", ""},
		{"inspect", "--config", malformed}, {"inspect", "--config", oversized},
		{"inspect", "--config", fifo}, {"check", "--config", dir},
		{"inspect", "--config", filepath.Join(dir, "PRIVATE_MISSING")},
		{"inspect", "--config", malformed, "PRIVATE_TRAILING"},
	} {
		var out bytes.Buffer
		err := runConfigCommand(args, &out)
		if err == nil || out.Len() != 0 {
			t.Fatal("invalid input accepted or partial output produced")
		}
		if strings.Contains(err.Error(), "PRIVATE") {
			t.Fatal("error leaked source or arguments")
		}
	}
}

func TestConfigImportStatePreservesSourceAndDoesNotOpenRuntimeResources(t *testing.T) {
	dir := t.TempDir()
	stateDir := filepath.Join(dir, "data")
	path := filepath.Join(dir, "legacy.toml")
	raw := fmt.Sprintf("data_dir = %q\n", stateDir) + `
[telemt]
url = 'http://unreachable.invalid:1'
auth_header = 'PRIVATE_API_TOKEN'
[auth]
username = 'admin'
password_hash = 'PRIVATE_PASSWORD'
jwt_secret = 'PRIVATE_JWT'
[telemt.auto_update]
enabled = true
auto_apply = true
check_interval = '5m'
[geoip]
db_path = '/not-opened/PRIVATE_CITY.mmdb'
[users]
data_quota_bytes = 1500000
`
	if err := os.WriteFile(path, []byte(raw), 0400); err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"imported", "already_imported"} {
		var out bytes.Buffer
		if err := runConfigCommand([]string{"import-state", "--config", path}, &out); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(out.String(), "PRIVATE") || !strings.Contains(out.String(), `"status":"`+status+`"`) || !strings.Contains(out.String(), `"imported_check_interval":"6h"`) {
			t.Fatal("incorrect or unsafe import report")
		}
	}
	after, err := os.ReadFile(path)
	if err != nil || string(after) != raw {
		t.Fatal("legacy source modified")
	}
	entries, err := os.ReadDir(stateDir)
	if err != nil || len(entries) != 1 || entries[0].Name() != panelStateFile {
		t.Fatal("import created runtime resources")
	}
	stateBytes, _ := os.ReadFile(filepath.Join(stateDir, panelStateFile))
	for _, secret := range []string{"PRIVATE_PASSWORD", "PRIVATE_API_TOKEN", "PRIVATE_JWT"} {
		if bytes.Contains(stateBytes, []byte(secret)) {
			t.Fatal("startup credential copied into migration state")
		}
	}
	// Current-format input must be rejected before creating its data directory.
	currentDir := filepath.Join(dir, "current-data")
	current := strings.Replace(raw, stateDir, currentDir, 1)
	current = strings.Replace(current, "jwt_secret = 'PRIVATE_JWT'", "", 1)
	current = strings.Split(current, "[telemt.auto_update]")[0]
	hash, _ := bcrypt.GenerateFromPassword([]byte("password"), bcrypt.MinCost)
	current = strings.Replace(current, "PRIVATE_PASSWORD", string(hash), 1)
	currentPath := filepath.Join(dir, "current.toml")
	if err := os.WriteFile(currentPath, []byte(current), 0600); err != nil {
		t.Fatal(err)
	}
	if err := runConfigCommand([]string{"import-state", "--config", currentPath}, &bytes.Buffer{}); err == nil {
		t.Fatal("current config accepted for legacy import")
	}
	if _, err := os.Stat(currentDir); !os.IsNotExist(err) {
		t.Fatal("rejected import created data_dir")
	}
}
