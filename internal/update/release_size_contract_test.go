package update

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestReleaseSizeGateMeasuresAllTargetsAndRejectsOverflow(t *testing.T) {
	if _, err := exec.LookPath("make"); err != nil {
		t.Skip("make is required to exercise the release size gate")
	}
	makefile, err := os.ReadFile(filepath.Join("..", "..", "Makefile"))
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []struct {
		name       string
		full, lite int64
		wantOK     bool
	}{
		{"exact-limits", 33554432, 16777216, true},
		{"lite-overflow", 33554432, 16777217, false},
		{"both-overflow", 33554433, 16777217, false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "Makefile"), makefile, 0o600); err != nil {
				t.Fatal(err)
			}
			for _, profile := range []string{"full", "lite"} {
				for _, arch := range []string{"x86_64", "aarch64"} {
					path := filepath.Join(dir, "release", ".stage", profile, arch, "telemt-panel")
					if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
						t.Fatal(err)
					}
					file, err := os.Create(path)
					if err != nil {
						t.Fatal(err)
					}
					size := scenario.full
					if profile == "lite" {
						size = scenario.lite
					}
					err = file.Truncate(size)
					closeErr := file.Close()
					if err != nil || closeErr != nil {
						t.Fatalf("fixture: %v, %v", err, closeErr)
					}
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, "make", "--no-print-directory", "release-size")
			command.Dir = dir
			output, err := command.CombinedOutput()
			if (err == nil) != scenario.wantOK {
				t.Fatalf("size gate: %v\n%s", err, output)
			}
			for _, target := range []string{"full/x86_64", "full/aarch64", "lite/x86_64", "lite/aarch64"} {
				if !strings.Contains(string(output), target) {
					t.Errorf("missing measurement of %s:\n%s", target, output)
				}
			}
		})
	}
}
