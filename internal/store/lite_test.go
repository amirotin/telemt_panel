//go:build lite

package store

import (
	"errors"
	"strings"
	"testing"
)

func TestLiteVariantDrivers(t *testing.T) {
	if Variant != "lite" {
		t.Fatalf("Variant = %q", Variant)
	}
	if got := AvailableDrivers(); len(got) != 1 || got[0] != "memory" {
		t.Fatalf("AvailableDrivers = %v", got)
	}
	for _, name := range []string{"sqlite"} {
		_, err := Open(OpenOptions{Driver: name})
		if err == nil || !strings.Contains(err.Error(), "install the full variant") {
			t.Fatalf("Open(%q) error = %v", name, err)
		}
		var unavailable *UnavailableDriverError
		if !errors.As(err, &unavailable) || unavailable.Driver != name || IsRuntimeOpenError(err) {
			t.Fatalf("Open(%q) error type = %T", name, err)
		}
	}
}
