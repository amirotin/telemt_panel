package main

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/migration"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/update"
	"golang.org/x/crypto/bcrypt"
)

func legacyStartupFixture(t *testing.T, password string) (string, string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	raw := fmt.Sprintf("data_dir = %q\nlisten = '127.0.0.1:48289'\nbase_path = '/panel/'\n[auth]\nusername = 'admin'\npassword_hash = '%s'\njwt_secret = 'PRIVATE_OLD_JWT'\n[telemt]\nurl = 'http://127.0.0.1:1'\nauth_header = 'PRIVATE_API_TOKEN'\n[telemt.auto_update]\nenabled = true\nauto_apply = true\ncheck_interval = '5m'\n", filepath.Join(dir, "data"), password)
	if err := os.WriteFile(path, []byte(raw), 0400); err != nil {
		t.Fatal(err)
	}
	return path, raw
}

func TestLegacyStartupPreservesIdentitySettingsAndSource(t *testing.T) {
	for _, plaintext := range []bool{true, false} {
		t.Run(fmt.Sprintf("plaintext=%v", plaintext), func(t *testing.T) {
			password := "PRIVATE_PASSWORD"
			if !plaintext {
				hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
				if err != nil {
					t.Fatal(err)
				}
				password = string(hash)
			}
			path, raw := legacyStartupFixture(t, password)
			var stableHash, stableSecret string
			changed := update.AutoSettings{Telemt: update.AutoModeOff, Panel: update.AutoModeCheck, Interval: 12 * time.Hour}
			for iteration := range 3 {
				source, err := loadStartupSource(path)
				if err != nil {
					t.Fatal(err)
				}
				st, err := newSourceStore(source)
				if err != nil {
					t.Fatal(err)
				}
				cfg := source.Config
				if cfg.BasePath != "/panel" || cfg.Auth.SessionTTLDuration() != 24*time.Hour || !auth.VerifyPassword(cfg.Auth.PasswordHash, "PRIVATE_PASSWORD") {
					t.Fatal("legacy runtime/auth semantics changed")
				}
				if iteration == 0 {
					stableHash, stableSecret = cfg.Auth.PasswordHash, cfg.Subpage.Secret
					if len(stableSecret) < 32 || cfg.Subpage.Enabled {
						t.Fatal("subscription key missing or pages unexpectedly enabled")
					}
					auto, _ := update.GetAutoSettings(st)
					if auto.Telemt != update.AutoModeCheck || auto.Panel != update.AutoModeOff || auto.Interval != 6*time.Hour {
						t.Fatal("initial scheduler policy changed")
					}
					now := time.Now()
					if err := st.PutSession(store.Session{IDHash: auth.HashToken("new-session"), Created: now, LastSeen: now}); err != nil {
						t.Fatal(err)
					}
					if err := update.SetAutoSettings(st, changed); err != nil {
						t.Fatal(err)
					}
				} else {
					if cfg.Auth.PasswordHash != stableHash || cfg.Subpage.Secret != stableSecret {
						t.Fatal("persistent identity or key regenerated")
					}
					auto, _ := update.GetAutoSettings(st)
					if auto != changed {
						t.Fatal("legacy config overwrote administrator settings")
					}
					recorder := httptest.NewRecorder()
					req := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
					req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: "new-session"})
					auth.RequireSession(st, cfg)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) })).ServeHTTP(recorder, req)
					if recorder.Code != 204 {
						t.Fatal("restart invalidated the new session")
					}
				}
				st.Close()
				after, _ := os.ReadFile(path)
				if string(after) != raw {
					t.Fatal("compatibility startup rewrote source")
				}
				stateBytes, _ := os.ReadFile(filepath.Join(cfg.DataDir, panelStateFile))
				for _, secret := range []string{"PRIVATE_PASSWORD", "PRIVATE_OLD_JWT", "PRIVATE_API_TOKEN"} {
					if bytes.Contains(stateBytes, []byte(secret)) {
						t.Fatal("raw startup credentials copied into state")
					}
				}
			}
		})
	}
}

func TestLegacyStartupAfterExplicitStateImportAndPasswordChange(t *testing.T) {
	path, raw := legacyStartupFixture(t, "original-password")
	source, _ := loadStartupSource(path)
	statePath, _ := resolveStatePath(source.Config.DataDir)
	state, _ := store.NewState(statePath)
	if _, err := migration.ImportLegacyState(state, source); err != nil {
		t.Fatal(err)
	}
	state.Close()
	st, err := newSourceStore(source)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := st.PutSession(store.Session{IDHash: auth.HashToken("before-change"), Created: now, LastSeen: now}); err != nil {
		t.Fatal(err)
	}
	st.Close()
	raw = strings.Replace(raw, "original-password", "new-password", 1)
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(raw), 0400); err != nil {
		t.Fatal(err)
	}
	var changedHash string
	for iteration := range 2 {
		source, _ = loadStartupSource(path)
		st, err = newSourceStore(source)
		if err != nil {
			t.Fatal(err)
		}
		if !auth.VerifyPassword(source.Config.Auth.PasswordHash, "new-password") {
			t.Fatal("new legacy password not applied")
		}
		if iteration == 0 {
			changedHash = source.Config.Auth.PasswordHash
		} else if source.Config.Auth.PasswordHash != changedHash {
			t.Fatal("changed password is not stable across restarts")
		}
		if _, exists, err := st.GetSession(auth.HashToken("before-change")); err != nil || exists {
			t.Fatal("old session survived password change")
		}
		st.Close()
	}
}

func TestLegacyStartupGeoIPFailureIsOptionalAndConfigLoadStaysStrict(t *testing.T) {
	path, raw := legacyStartupFixture(t, "password")
	raw += "\n[geoip]\ndb_path='/missing/PRIVATE_GEOIP'\n"
	source, err := config.DecodeSource([]byte(raw), path, "auto")
	if err != nil {
		t.Fatal(err)
	}
	st, err := newSourceStore(source)
	if err != nil {
		t.Fatalf("optional GeoIP blocked startup: %v", err)
	}
	st.Close()
	if _, err := config.Load(path); err == nil {
		t.Fatal("strict current loader accepted legacy")
	}
	if file, err := config.OpenTLSFile(path); err == nil {
		file.Close()
		t.Fatal("transport editor could rewrite legacy source")
	}
}
