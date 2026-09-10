package geoip

import (
	"net/netip"
	"testing"

	"github.com/oschwald/maxminddb-golang/v2"
)

func TestManagerWrongRecordSchemaKeepsPreviousBundle(t *testing.T) {
	dataDir := t.TempDir()
	settings := newMemorySettings()
	manager := NewManager(dataDir, settings)
	defer manager.Close()
	if _, err := manager.PutConfig(fileConfig(writeFixture(t, "country"), "", "")); err != nil {
		t.Fatal(err)
	}
	waitState(t, manager, StateReady)
	bad := writeFixture(t, "wrong-country")
	reader, err := maxminddb.Open(bad)
	if err != nil {
		t.Fatal(err)
	}
	if err := reader.Verify(); err != nil {
		t.Fatalf("fixture must be structurally valid: %v", err)
	}
	reader.Close()
	if _, err := manager.PutConfig(fileConfig(bad, "", "")); err != nil {
		t.Fatal(err)
	}
	status := waitState(t, manager, StateError)
	if !status.Available || status.LastError == nil || *status.LastError != ErrorDatabaseInvalid {
		t.Fatalf("status = %+v", status)
	}
	if got := manager.Lookup("81.2.69.142"); got == nil || got.CountryCode != "GB" {
		t.Fatalf("old lookup lost: %+v", got)
	}
	manager.Close()
	restored := NewManager(dataDir, settings)
	defer restored.Close()
	if got := restored.Lookup("81.2.69.142"); got == nil || got.CountryCode != "GB" {
		t.Fatalf("old lookup lost on restart: %+v", got)
	}
}

func TestManagerOptionalRecordFieldsAllowed(t *testing.T) {
	manager := NewManager(t.TempDir(), newMemorySettings())
	defer manager.Close()
	if _, err := manager.PutConfig(fileConfig(writeFixture(t, "optional-country"), "", "")); err != nil {
		t.Fatal(err)
	}
	waitState(t, manager, StateReady)
	if got := manager.Lookup("81.2.69.142"); got == nil || got.CountryCode != "GB" || got.CountryName != "" {
		t.Fatalf("optional fields: %+v", got)
	}
}

func TestRecordSchemaOffsetsAreScopedToEachDatabase(t *testing.T) {
	var firstOffset uintptr
	for i, kind := range []string{"optional-country", "wrong-country", "optional-country"} {
		reader, err := maxminddb.Open(writeFixture(t, kind))
		if err != nil {
			t.Fatal(err)
		}
		if err := reader.Verify(); err != nil {
			reader.Close()
			t.Fatal(err)
		}
		// The same offset is valid in one database and has a wrong field type
		// in another. A previous reader's validation must never bypass it.
		result := reader.Lookup(netip.MustParseAddr("81.2.69.142"))
		if !result.Found() || result.Err() != nil {
			reader.Close()
			t.Fatal("fixture record missing")
		}
		if i == 0 {
			firstOffset = result.Offset()
		} else if result.Offset() != firstOffset {
			reader.Close()
			t.Fatal("fixtures must reuse the same offset")
		}
		err = verifyRecordSchema(reader, KindCountry)
		reader.Close()
		if (err != nil) != (kind == "wrong-country") {
			t.Fatalf("record schema %s: %v", kind, err)
		}
	}
}
