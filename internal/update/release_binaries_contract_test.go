package update

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestReleaseBinariesRejectsPlaceholderSPA(t *testing.T) {
	if _, err := exec.LookPath("make"); err != nil {
		t.Skip("make is required")
	}
	makefile, err := os.ReadFile(filepath.Join("..", "..", "Makefile"))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "Makefile"), makefile, 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("make", "--no-print-directory", "release-binaries")
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "build frontend first") {
		t.Fatalf("placeholder check: %v\n%s", err, output)
	}
}
