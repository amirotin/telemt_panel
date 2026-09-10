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
