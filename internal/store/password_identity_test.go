package store

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestBindPasswordAuthPreservesState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel-state.json")
	m, err := NewState(path)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	if err := m.BindPasswordAuth("admin", "first-hash"); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	m.sessions["session"] = Session{IDHash: "session", LastSeen: now}
	m.webauthnChallenges["pending"] = WebAuthnChallenge{}
	m.webauthnUserHandle = bytes.Repeat([]byte{1}, 64)
	m.webauthnCredentials["aWQ"] = WebAuthnCredential{ID: "aWQ", Name: "Phone", CredentialData: []byte("credential"), Created: now}
	m.settings["preserved"] = "value"
	m.subpageNonces["user"] = "nonce"
	before, err := m.ExportData()
	if err != nil {
		t.Fatal(err)
	}
	if err := m.BindPasswordAuth("admin", "second-hash"); err != nil {
		t.Fatal(err)
	}
	if len(m.webauthnChallenges) != 0 {
		t.Fatal("in-flight challenges survived")
	}
	after, err := m.ExportData()
	if err != nil {
		t.Fatal(err)
	}
	before.Sessions = after.Sessions
	before.Settings[passwordIdentityKey] = after.Settings[passwordIdentityKey]
	if len(after.Sessions) != 0 || !reflect.DeepEqual(before, after) {
		t.Fatal("binding changed state other than sessions and password identity")
	}
	reopened, err := NewState(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if len(reopened.sessions) != 0 || len(reopened.webauthnCredentials) != 1 || reopened.settings["preserved"] != "value" {
		t.Fatal("persisted state was not preserved")
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("state permissions: %v, %v", info, err)
	}
}

func TestBindPasswordAuthNoWriteWhenUnchanged(t *testing.T) {
	m, _ := NewState("")
	defer m.Close()
	if err := m.BindPasswordAuth("admin", "hash"); err != nil {
		t.Fatal(err)
	}
	m.sessions["session"] = Session{IDHash: "session"}
	m.statePath = filepath.Join(t.TempDir(), "absent", "state.json")
	if err := m.BindPasswordAuth("admin", "hash"); err != nil || len(m.sessions) != 1 {
		t.Fatalf("unchanged binding wrote state or revoked sessions: %v", err)
	}
}

func TestBindPasswordAuthRollsBackOnWriteFailure(t *testing.T) {
	for _, existing := range []bool{false, true} {
		t.Run(map[bool]string{false: "legacy", true: "bound"}[existing], func(t *testing.T) {
			m, _ := NewState("")
			defer m.Close()
			if existing {
				if err := m.BindPasswordAuth("admin", "hash"); err != nil {
					t.Fatal(err)
				}
			}
			previous := m.settings[passwordIdentityKey]
			m.sessions["session"] = Session{IDHash: "session"}
			m.webauthnChallenges["challenge"] = WebAuthnChallenge{}
			m.statePath = filepath.Join(t.TempDir(), "absent", "state.json")
			if err := m.BindPasswordAuth("admin", "new-hash"); err == nil {
				t.Fatal("ignored persistence failure")
			}
			value, present := m.settings[passwordIdentityKey]
			if value != previous || present != existing || len(m.sessions) != 1 || len(m.webauthnChallenges) != 1 {
				t.Fatal("failed binding changed in-memory state")
			}
		})
	}
}

func TestBindPasswordAuthAccountChangeAndPortableState(t *testing.T) {
	source, _ := NewState("")
	defer source.Close()
	if err := source.BindPasswordAuth("admin", "hash"); err != nil {
		t.Fatal(err)
	}
	session := Session{IDHash: strings.Repeat("a", 64), Created: time.Now(), LastSeen: time.Now()}
	source.sessions[session.IDHash] = session
	data, err := source.ExportData()
	if err != nil {
		t.Fatal(err)
	}
	for _, username := range []string{"admin", "other-admin"} {
		t.Run(username, func(t *testing.T) {
			destination, _ := NewState("")
			defer destination.Close()
			if err := destination.ImportData(data); err != nil {
				t.Fatal(err)
			}
			if err := destination.BindPasswordAuth(username, "hash"); err != nil {
				t.Fatal(err)
			}
			want := 0
			if username == "admin" {
				want = 1
			}
			if len(destination.sessions) != want {
				t.Fatalf("sessions = %d, want %d", len(destination.sessions), want)
			}
		})
	}
}
