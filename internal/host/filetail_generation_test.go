package host

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestReadNewLinesCopytruncateDuringEmit(t *testing.T) {
	for _, size := range []int{2 * followChunkBytes, maxFollowLineBytes + followChunkBytes} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "service.log")
			old := "first\n" + strings.Repeat("O", size) + "\n"
			fresh := "fresh\n" + strings.Repeat("N", size) + "\n"
			if err := os.WriteFile(path, []byte(old), 0o600); err != nil {
				t.Fatal(err)
			}
			f, err := os.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			var cursor fileFollowCursor
			var lines []string
			scratch := make([]byte, followChunkBytes)
			err = readNewLines(context.Background(), f, int64(len(old)), &cursor, scratch, func(line string) bool {
				lines = append(lines, line)
				if len(lines) == 1 {
					// A stalled consumer gives logrotate time to refill the same inode.
					if err := os.WriteFile(path, []byte(fresh), 0o600); err != nil {
						t.Fatal(err)
					}
				}
				return true
			})
			if err != nil {
				t.Fatal(err)
			}
			for _, line := range lines {
				if strings.Contains(line, "O") && strings.Contains(line, "N") {
					t.Fatalf("mixed-generation line: old=%d new=%d", strings.Count(line, "O"), strings.Count(line, "N"))
				}
			}
			if cursor.offset != 0 || len(cursor.partial) != 0 || cursor.truncated {
				t.Fatal("changed generation did not reset the cursor")
			}
			if err := readNewLines(context.Background(), f, int64(len(fresh)), &cursor, scratch, func(line string) bool {
				lines = append(lines, line)
				return true
			}); err != nil {
				t.Fatal(err)
			}
			wantLast := strings.Repeat("N", min(size, maxFollowLineBytes))
			if size > maxFollowLineBytes {
				wantLast += followLineMarker
			}
			if !reflect.DeepEqual(lines, []string{"first", "fresh", wantLast}) {
				t.Fatalf("unexpected recovered lines: count=%d", len(lines))
			}
		})
	}
}

func TestReadNewLinesCopytruncateDiscardsTruncatedPrefix(t *testing.T) {
	for _, fresh := range []string{"fresh\n", strings.Repeat("N", 2*maxFollowLineBytes) + "\n"} {
		t.Run(fmt.Sprint(len(fresh)), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "service.log")
			old := strings.Repeat("O", 2*maxFollowLineBytes) + "\n"
			if err := os.WriteFile(path, []byte(old), 0o600); err != nil {
				t.Fatal(err)
			}
			f, err := os.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			var cursor fileFollowCursor
			rewritten := false
			reader := followReaderAtFunc(func(p []byte, offset int64) (int, error) {
				if cursor.truncated && !rewritten {
					rewritten = true
					if err := os.WriteFile(path, []byte(fresh), 0o600); err != nil {
						t.Fatal(err)
					}
				}
				return f.ReadAt(p, offset)
			})
			scratch := make([]byte, followChunkBytes)
			if err := readNewLines(context.Background(), reader, int64(len(old)), &cursor, scratch, func(string) bool {
				t.Fatal("discarded generation was emitted")
				return false
			}); err != nil {
				t.Fatal(err)
			}
			if !rewritten || cursor.offset != 0 || len(cursor.partial) != 0 || cursor.truncated || cursor.overlapLen != 0 {
				t.Fatal("truncated generation was not fully reset")
			}
			var got []string
			if err := readNewLines(context.Background(), f, int64(len(fresh)), &cursor, scratch, func(line string) bool {
				got = append(got, line)
				return true
			}); err != nil {
				t.Fatal(err)
			}
			want := strings.TrimSuffix(fresh, "\n")
			if len(want) > maxFollowLineBytes {
				want = want[:maxFollowLineBytes] + followLineMarker
			}
			if !reflect.DeepEqual(got, []string{want}) {
				t.Fatal("fresh generation was not recovered")
			}
		})
	}
}

func TestFollowFileCopytruncateDuringLastDelivery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "service.log")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ticks := make(chan time.Time)
	lines := followFileTicks(ctx, path, ticks, func() {})
	appendLine(t, path, "first\nlast\n")
	followTestTick(t, ticks)
	if got := recvLine(t, lines, 2*time.Second); got != "first" {
		t.Fatalf("first line = %q", got)
	}
	// The final buffered line cannot finish delivery until after the rewrite.
	if err := os.WriteFile(path, []byte("fresh\nnext\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := recvLine(t, lines, 2*time.Second); got != "last" {
		t.Fatalf("last buffered line = %q", got)
	}
	followTestTick(t, ticks)
	for _, want := range []string{"fresh", "next"} {
		if got := recvLine(t, lines, 2*time.Second); got != want {
			t.Fatalf("recovered line = %q, want %q", got, want)
		}
	}
}

func TestReadNewLinesOverlapReadErrorPreservesCursor(t *testing.T) {
	for _, returned := range []string{"ab", "abcde"} {
		t.Run(returned, func(t *testing.T) {
			var cursor fileFollowCursor
			scratch := make([]byte, followChunkBytes)
			emit := func(string) bool { t.Fatal("partial line emitted"); return false }
			if err := readNewLines(context.Background(), strings.NewReader("abc"), 3, &cursor, scratch, emit); err != nil {
				t.Fatal(err)
			}
			failure := errors.New("read failed")
			reader := followReaderAtFunc(func(p []byte, offset int64) (int, error) {
				if offset != 0 {
					t.Fatalf("read did not include prior overlap: %d", offset)
				}
				return copy(p, returned), failure
			})
			if err := readNewLines(context.Background(), reader, 9, &cursor, scratch, emit); !errors.Is(err, failure) {
				t.Fatalf("read error lost: %v", err)
			}
			wantOffset := max(3, len(returned))
			if cursor.offset != int64(wantOffset) || len(cursor.partial) != wantOffset {
				t.Fatalf("consumed state changed: offset=%d partial=%q", cursor.offset, cursor.partial)
			}
			var got []string
			if err := readNewLines(context.Background(), strings.NewReader("abcdefgh\n"), 9, &cursor, scratch, func(line string) bool {
				got = append(got, line)
				return true
			}); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, []string{"abcdefgh"}) {
				t.Fatalf("resumed line corrupted: %q", got)
			}
		})
	}
}
