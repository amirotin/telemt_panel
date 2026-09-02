//go:build !lite

package store

import "testing"

func TestFullVariantIncludesSQLDrivers(t *testing.T) {
	if Variant != "full" {
		t.Fatalf("Variant = %q", Variant)
	}
	available := AvailableDrivers()
	want := []string{"memory", "mysql", "postgres", "sqlite"}
	if len(available) != len(want) {
		t.Fatalf("AvailableDrivers = %v", available)
	}
	for i := range want {
		if available[i] != want[i] {
			t.Fatalf("AvailableDrivers = %v, want %v", available, want)
		}
	}
}
