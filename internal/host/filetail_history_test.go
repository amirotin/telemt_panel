package host

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFileHistoryOffsetRecoversShortReadAfterTruncation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "telemt.log")
	if err := os.WriteFile(path, []byte(strings.Repeat("old entry\n", 100)), 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("new entry\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	offset, discard, err := fileHistoryOffset(f, info.Size(), 200)
	if err != nil {
		t.Fatalf("history selection failed after copytruncate: %v", err)
	}
	if offset != 0 || discard {
		t.Fatalf("cursor = %d, discard = %t, want start of new complete content", offset, discard)
	}
}
