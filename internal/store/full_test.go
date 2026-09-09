//go:build !lite

package store

import (
	"strings"
	"testing"
)

func TestFullVariantIncludesSQLite(t *testing.T) {
	if Variant != "full" {
		t.Fatalf("Variant = %q", Variant)
	}
	available := AvailableDrivers()
	want := []string{"memory", "sqlite"}
	if len(available) != len(want) {
		t.Fatalf("AvailableDrivers = %v", available)
	}
	for i := range want {
		if available[i] != want[i] {
			t.Fatalf("AvailableDrivers = %v, want %v", available, want)
		}
	}
}

func TestOpenSQLiteEmptyPathIsNotRuntimeFailure(t *testing.T) {
	_, err := Open(OpenOptions{Driver: "sqlite"})
	if err == nil || !strings.Contains(err.Error(), "path is empty") {
		t.Fatalf("Open sqlite empty path error = %v", err)
	}
	if IsRuntimeOpenError(err) {
		t.Fatalf("Open sqlite empty path classified as runtime failure: %T", err)
	}
}
