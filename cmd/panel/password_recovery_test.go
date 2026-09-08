package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/store"
)

func TestRunHashPassword(t *testing.T) {
	for _, tc := range []struct {
		name, input string
		valid       bool
	}{
		{"valid", "new-local-password\n", true},
		{"empty", "\n", false},
		{"bcrypt-limit", strings.Repeat("a", 73), false},
		{"oversized", strings.Repeat("a", 4097), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input, err := os.CreateTemp(t.TempDir(), "stdin")
			if err != nil {
				t.Fatal(err)
			}
			defer input.Close()
			if _, err := input.WriteString(tc.input); err != nil {
				t.Fatal(err)
			}
			if _, err := input.Seek(0, io.SeekStart); err != nil {
				t.Fatal(err)
			}
			output, writer, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer output.Close()
			defer writer.Close()
			previousInput, previousOutput := os.Stdin, os.Stdout
			os.Stdin, os.Stdout = input, writer
			defer func() { os.Stdin, os.Stdout = previousInput, previousOutput }()
			runErr := runHashPassword()
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			raw, err := io.ReadAll(output)
			if err != nil {
				t.Fatal(err)
			}
			if tc.valid {
				if runErr != nil || !auth.VerifyPassword(strings.TrimSpace(string(raw)), strings.TrimRight(tc.input, "\r\n")) {
					t.Fatalf("invalid generated hash: %v", runErr)
				}
			} else if runErr == nil || len(raw) != 0 {
				t.Fatal("invalid input produced a password hash")
			}
		})
	}
}

func TestReadPasswordInput(t *testing.T) {
	for _, input := range []string{"password", "password\n", "password\r\n"} {
		got, err := readPasswordInput(strings.NewReader(input))
		if err != nil || got != "password" {
			t.Fatalf("password input: %q, %v", got, err)
		}
	}
	if got, err := readPasswordInput(strings.NewReader(" password ")); err != nil || got != " password " {
		t.Fatal("password spaces were stripped")
	}
	if _, err := readPasswordInput(strings.NewReader(strings.Repeat("a", 4097))); err == nil {
		t.Fatal("oversized password input accepted")
	}
}

func TestPasswordRecoveryRevokesPersistedSessions(t *testing.T) {
	cfg := &config.Config{DataDir: t.TempDir(), Auth: config.AuthConfig{Username: "admin", PasswordHash: "old-hash"}}
	st, err := newStore(cfg)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := st.PutSession(store.Session{IDHash: auth.HashToken("old-cookie"), Created: now, LastSeen: now}); err != nil {
		t.Fatal(err)
	}
	if err := st.SetSetting("preserved", "value"); err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	check := func(want int) {
		t.Helper()
		reopened, err := newStore(cfg)
		if err != nil {
			t.Fatal(err)
		}
		defer reopened.Close()
		r := httptest.NewRequest("GET", "/", nil)
		r.AddCookie(&http.Cookie{Name: auth.CookieName, Value: "old-cookie"})
		w := httptest.NewRecorder()
		auth.RequireSession(reopened, cfg)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		})).ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("old session status = %d, want %d", w.Code, want)
		}
		if value, _, err := reopened.GetSetting("preserved"); err != nil || value != "value" {
			t.Fatalf("setting lost: %q, %v", value, err)
		}
	}
	check(http.StatusNoContent)
	cfg.Auth.PasswordHash = "new-hash"
	check(http.StatusUnauthorized)
	check(http.StatusUnauthorized)
	cfg.Auth.PasswordHash = "old-hash"
	check(http.StatusUnauthorized)
}

func TestPasswordRecoveryInvalidatesLegacySessions(t *testing.T) {
	cfg := &config.Config{DataDir: t.TempDir(), Auth: config.AuthConfig{Username: "admin", PasswordHash: "hash"}}
	legacy, err := store.NewState(filepath.Join(cfg.DataDir, panelStateFile))
	if err != nil {
		t.Fatal(err)
	}
	if err := legacy.PutSession(store.Session{IDHash: "legacy"}); err != nil {
		t.Fatal(err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}
	st, err := newStore(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if sessions, err := st.ListSessions(); err != nil || len(sessions) != 0 {
		t.Fatalf("legacy sessions survived: %d, %v", len(sessions), err)
	}
}
