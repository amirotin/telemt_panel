package store

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/atomicfile"
)

func TestStatePublishedFailureKeepsMemoryAndDiskConsistent(t *testing.T) {
	for _, operation := range []string{"session", "delete session", "delete other sessions", "setting", "nonce", "journal", "audit", "purge audit", "policies", "password", "webauthn handle", "import"} {
		t.Run(operation, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "state.json")
			state, err := NewMemory(path)
			if err != nil {
				t.Fatal(err)
			}
			defer state.Close()
			if operation != "import" {
				if err := state.PutSession(Session{IDHash: "existing", LastSeen: time.Now()}); err != nil {
					t.Fatal(err)
				}
			}
			cause := errors.New("directory sync failed after publication")
			state.publishState = func(dest string, mode os.FileMode, write func(io.Writer) error) (bool, error) {
				published, err := atomicfile.Write(dest, mode, write)
				if err != nil {
					return published, err
				}
				return true, &atomicfile.PublicationError{Err: cause}
			}
			switch operation {
			case "session":
				err = state.PutSession(Session{IDHash: "new", LastSeen: time.Now()})
			case "delete session":
				err = state.DeleteSession("existing")
			case "delete other sessions":
				err = state.DeleteOtherSessions("keep")
			case "setting":
				err = state.SetSetting("new", "value")
			case "nonce":
				err = state.SetSubpageNonce("alice", "nonce")
			case "journal":
				err = state.AppendUpdateJournal(UpdateJournalEntry{Target: "panel", RunID: "run", Phase: "failed", TS: time.Now()})
			case "audit":
				err = state.AppendAudit(AuditEntry{ID: "audit", Action: "test", TS: time.Now()})
			case "purge audit":
				err = state.PurgeAudit()
			case "policies":
				p := DefaultStoragePolicies()
				p[0].Enabled = false
				err = state.ReplaceStoragePoliciesContext(context.Background(), p)
			case "password":
				err = state.BindPasswordAuth("admin", "hash")
			case "webauthn handle":
				_, err = state.GetOrCreateWebAuthnUserHandle(make([]byte, webAuthnUserHandleBytes))
			case "import":
				err = state.ImportData(PortableData{FormatVersion: portableFormatVersion, Settings: map[string]string{"imported": "true"}})
			}
			if !errors.Is(err, cause) {
				t.Fatalf("publication error=%v, want surfaced durability error", err)
			}
			reopened, err := NewMemory(path)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			live, err := state.ExportData()
			if err != nil {
				t.Fatal(err)
			}
			disk, err := reopened.ExportData()
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(live, disk) {
				t.Fatalf("memory diverged from published disk: live=%+v disk=%+v", live, disk)
			}
		})
	}
}

func TestCompositePublishedPolicyFailureAppliesVisibleHistoryPolicy(t *testing.T) {
	state, err := NewMemory(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	history, err := NewMemoryHistory()
	if err != nil {
		t.Fatal(err)
	}
	combined, err := NewComposite(state, history)
	if err != nil {
		t.Fatal(err)
	}
	defer combined.Close()
	cause := errors.New("post-publication policy durability failure")
	state.publishState = func(dest string, mode os.FileMode, write func(io.Writer) error) (bool, error) {
		published, err := atomicfile.Write(dest, mode, write)
		if err != nil {
			return published, err
		}
		return true, &atomicfile.PublicationError{Err: cause}
	}
	policies := DefaultStoragePolicies()
	policies[0].Enabled = false
	if err := combined.ReplaceStoragePolicies(policies); !errors.Is(err, cause) {
		t.Fatalf("error=%v", err)
	}
	actual, err := history.ListStoragePolicies()
	if err != nil || !reflect.DeepEqual(actual, policies) {
		t.Fatalf("history policy differs from published state: %+v error=%v", actual, err)
	}
}

func TestCompositePublishedImportFailureRetainsVisibleHistory(t *testing.T) {
	state, err := NewMemory(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	history, err := NewMemoryHistory()
	if err != nil {
		t.Fatal(err)
	}
	combined, err := NewComposite(state, history)
	if err != nil {
		t.Fatal(err)
	}
	defer combined.Close()
	cause := errors.New("post-publication import durability failure")
	state.publishState = func(dest string, mode os.FileMode, write func(io.Writer) error) (bool, error) {
		published, err := atomicfile.Write(dest, mode, write)
		if err != nil {
			return published, err
		}
		return true, &atomicfile.PublicationError{Err: cause}
	}
	data := PortableData{FormatVersion: portableFormatVersion, Settings: map[string]string{"imported": "true"}, Metrics: map[string][]MetricPoint{"traffic": {{TS: time.Now().Unix(), Value: 42}}}}
	if err := combined.ImportData(data); !errors.Is(err, cause) {
		t.Fatalf("error=%v", err)
	}
	points, err := history.MetricRange("traffic", 0)
	if err != nil || len(points) != 1 || points[0].Value != 42 {
		t.Fatalf("imported history rolled back after state became visible: %+v error=%v", points, err)
	}
}
