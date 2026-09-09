package host

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestFollowFileMarksOversizedLineWithoutChangingSource(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ticks := make(chan time.Time, 1)
	lines := followFileTicks(ctx, path, ticks, func() {})
	content := strings.Repeat("x", 8*maxTailBytes) + "\nnext\n"
	appendLine(t, path, content)
	ticks <- time.Now()
	got := recvLine(t, lines, 2*time.Second)
	want := strings.Repeat("x", maxTailBytes) + " [line truncated after 262144 bytes]"
	if got != want {
		t.Fatalf("oversized line has %d bytes, want bounded prefix and marker (%d bytes)", len(got), len(want))
	}
	if next := recvLine(t, lines, 2*time.Second); next != "next" {
		t.Fatalf("next line = %q", next)
	}
	stored, err := os.ReadFile(path)
	if err != nil || string(stored) != content {
		t.Fatal("following changed the source file")
	}
}

func TestFollowFileInitialPartialContentRemainsHistorical(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log")
	if err := os.WriteFile(path, []byte("historical prefix"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ticks := make(chan time.Time, 1)
	lines := followFileTicks(ctx, path, ticks, func() {})
	appendLine(t, path, " appended suffix\n")
	ticks <- time.Now()
	if got := recvLine(t, lines, 2*time.Second); got != " appended suffix" {
		t.Fatalf("historical partial content was replayed: %q", got)
	}
}

type followReaderAtFunc func([]byte, int64) (int, error)

func (f followReaderAtFunc) ReadAt(p []byte, offset int64) (int, error) {
	return f(p, offset)
}

func TestReadNewLinesChunkAndLineBoundaries(t *testing.T) {
	for _, length := range []int{0, followChunkBytes - 1, followChunkBytes, followChunkBytes + 1, maxFollowLineBytes - 1, maxFollowLineBytes, maxFollowLineBytes + 1, 8 * maxFollowLineBytes} {
		t.Run(fmt.Sprint(length), func(t *testing.T) {
			content := strings.Repeat("x", length) + "\n\n\r\nlast\n"
			var cursor fileFollowCursor
			var got []string
			err := readNewLines(context.Background(), strings.NewReader(content), int64(len(content)), &cursor, make([]byte, followChunkBytes), func(line string) bool {
				got = append(got, line)
				return true
			})
			first := strings.Repeat("x", min(length, maxFollowLineBytes))
			if length > maxFollowLineBytes {
				first += followLineMarker
			}
			if err != nil || !slices.Equal(got, []string{first, "", "\r", "last"}) {
				t.Fatalf("line boundaries/order not preserved: error=%v, lines=%d", err, len(got))
			}
			if cursor.offset != int64(len(content)) || len(cursor.partial) != 0 || cap(cursor.partial) > maxFollowLineBytes || cursor.truncated {
				t.Fatalf("invalid cursor after complete lines: offset=%d len=%d cap=%d truncated=%v", cursor.offset, len(cursor.partial), cap(cursor.partial), cursor.truncated)
			}
		})
	}
}

func TestReadNewLinesTrimsOnlyIncompleteUTF8AtCap(t *testing.T) {
	for _, available := range []int{1, 2, 3, 4} {
		t.Run(fmt.Sprint(available), func(t *testing.T) {
			prefix := strings.Repeat("a", maxFollowLineBytes-available)
			content := prefix + "😀suffix\n"
			want := prefix
			if available == 4 {
				want += "😀"
			}
			want += followLineMarker
			var cursor fileFollowCursor
			var got string
			err := readNewLines(context.Background(), strings.NewReader(content), int64(len(content)), &cursor, make([]byte, followChunkBytes), func(line string) bool { got = line; return true })
			if err != nil || got != want || !utf8.ValidString(got) {
				t.Fatalf("split rune not trimmed safely: error=%v length=%d", err, len(got))
			}
		})
	}
	content := strings.Repeat("x", maxFollowLineBytes-1) + "\xffmore\n"
	var cursor fileFollowCursor
	err := readNewLines(context.Background(), strings.NewReader(content), int64(len(content)), &cursor, make([]byte, followChunkBytes), func(line string) bool {
		if line != content[:maxFollowLineBytes]+followLineMarker {
			t.Fatal("original invalid byte was normalized")
		}
		return true
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestReadNewLinesConsumesOnlyAppendedBytesAndCapturedEnd(t *testing.T) {
	content := strings.Repeat("x", 8*maxFollowLineBytes) + "\nend\n"
	reader := strings.NewReader(content)
	var cursor fileFollowCursor
	var end, total int64
	reads := 0
	tracked := followReaderAtFunc(func(p []byte, offset int64) (int, error) {
		if len(p) > followChunkBytes || offset != total || offset+int64(len(p)) > end {
			t.Fatalf("unexpected read offset=%d width=%d total=%d end=%d", offset, len(p), total, end)
		}
		n, err := reader.ReadAt(p, offset)
		total += int64(n)
		reads++
		return n, err
	})
	var got []string
	// The helper also clamps reads when a caller supplies a larger buffer.
	scratch := make([]byte, 2*followChunkBytes)
	for _, target := range []int{1, followChunkBytes + 1, maxFollowLineBytes + 1, 8 * maxFollowLineBytes, len(content)} {
		end = int64(target)
		if err := readNewLines(context.Background(), tracked, end, &cursor, scratch, func(line string) bool { got = append(got, line); return true }); err != nil {
			t.Fatal(err)
		}
		if cursor.offset != end || len(cursor.partial) > maxFollowLineBytes || cap(cursor.partial) > maxFollowLineBytes {
			t.Fatalf("unbounded or unread cursor at %d", target)
		}
		if target < len(content) && len(got) != 0 {
			t.Fatal("partial line emitted before newline")
		}
		before := reads
		if err := readNewLines(context.Background(), tracked, end, &cursor, scratch, func(string) bool { t.Fatal("emitted without growth"); return false }); err != nil || reads != before {
			t.Fatalf("no-growth poll reread content: %v", err)
		}
	}
	if len(got) != 2 || got[0] != content[:maxFollowLineBytes]+followLineMarker || got[1] != "end" || total != int64(len(content)) {
		t.Fatalf("unexpected final delivery: lines=%d consumed=%d", len(got), total)
	}
}

func TestReadNewLinesStopsForCancellationBackpressureAndReadErrors(t *testing.T) {
	scratch := make([]byte, followChunkBytes)
	t.Run("cancel while discarding unfinished line", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		cursor := fileFollowCursor{partial: bytes.Repeat([]byte{'x'}, maxFollowLineBytes), truncated: true}
		reads := 0
		reader := followReaderAtFunc(func(p []byte, _ int64) (int, error) {
			reads++
			for i := range p {
				p[i] = 'x'
			}
			cancel()
			return len(p), nil
		})
		err := readNewLines(ctx, reader, 1<<30, &cursor, scratch, func(string) bool { t.Fatal("unfinished line emitted"); return true })
		if !errors.Is(err, context.Canceled) || reads != 1 || cursor.offset != followChunkBytes {
			t.Fatalf("cancel did not stop chunk reads: error=%v reads=%d offset=%d", err, reads, cursor.offset)
		}
	})
	t.Run("callback stops at emitted line", func(t *testing.T) {
		var cursor fileFollowCursor
		reader := strings.NewReader("a\nb\n")
		calls := 0
		err := readNewLines(context.Background(), reader, 4, &cursor, scratch, func(string) bool { calls++; return false })
		if err != nil || calls != 1 || cursor.offset != 2 {
			t.Fatalf("callback stop ignored: %v, calls=%d offset=%d", err, calls, cursor.offset)
		}
		if err := readNewLines(context.Background(), reader, 4, &cursor, scratch, func(line string) bool {
			if line != "b" {
				t.Fatalf("resumed line=%q", line)
			}
			return true
		}); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("partial read and error preserve consumed prefix", func(t *testing.T) {
		var cursor fileFollowCursor
		failure := errors.New("read failed")
		reader := followReaderAtFunc(func(p []byte, _ int64) (int, error) { return copy(p, "abc"), failure })
		if err := readNewLines(context.Background(), reader, 7, &cursor, scratch, func(string) bool { t.Fatal("partial emitted"); return false }); !errors.Is(err, failure) || cursor.offset != 3 {
			t.Fatalf("read state lost: %v offset=%d", err, cursor.offset)
		}
		if err := readNewLines(context.Background(), strings.NewReader("abcdef\n"), 7, &cursor, scratch, func(line string) bool {
			if line != "abcdef" {
				t.Fatalf("line=%q", line)
			}
			return true
		}); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("zero progress and scratch guard", func(t *testing.T) {
		var cursor fileFollowCursor
		reader := followReaderAtFunc(func([]byte, int64) (int, error) { return 0, nil })
		if err := readNewLines(context.Background(), reader, 1, &cursor, scratch, func(string) bool { return true }); !errors.Is(err, io.ErrNoProgress) {
			t.Fatalf("zero read loop: %v", err)
		}
		if err := readNewLines(context.Background(), reader, 1, &cursor, nil, func(string) bool { return true }); !errors.Is(err, io.ErrShortBuffer) {
			t.Fatalf("empty scratch: %v", err)
		}
	})
}

func followTestTick(t *testing.T, ticks chan<- time.Time) {
	t.Helper()
	select {
	case ticks <- time.Now():
	case <-time.After(2 * time.Second):
		t.Fatal("follower did not reach its tick wait")
	}
}

func TestFollowFileResetsPartialAndTruncatedGenerations(t *testing.T) {
	for _, size := range []int{13, maxFollowLineBytes + 1024} {
		for _, change := range []string{"rotate", "shrink", "copytruncate"} {
			t.Run(fmt.Sprintf("%s/%d", change, size), func(t *testing.T) {
				path := filepath.Join(t.TempDir(), "log")
				if err := os.WriteFile(path, nil, 0o600); err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				ticks := make(chan time.Time)
				lines := followFileTicks(ctx, path, ticks, func() {})
				appendLine(t, path, strings.Repeat("a", size))
				followTestTick(t, ticks)
				// A second handshake proves the first pending prefix was read.
				followTestTick(t, ticks)
				fresh := "fresh"
				if change == "rotate" {
					if err := os.Rename(path, path+".old"); err != nil {
						t.Fatal(err)
					}
				} else if change == "copytruncate" {
					fresh = strings.Repeat("N", size+100)
				}
				if err := os.WriteFile(path, []byte(fresh+"\n"), 0o600); err != nil {
					t.Fatal(err)
				}
				// The preceding tick may observe the rewrite itself; avoid waiting
				// for another tick while its output is blocked.
				select {
				case ticks <- time.Now():
				case got := <-lines:
					want := fresh[:min(len(fresh), maxFollowLineBytes)]
					if len(fresh) > maxFollowLineBytes {
						want += followLineMarker
					}
					if got != want {
						t.Fatal("old generation prefix leaked")
					}
					return
				case <-time.After(2 * time.Second):
					t.Fatal("follower did not process rewritten file")
				}
				want := fresh[:min(len(fresh), maxFollowLineBytes)]
				if len(fresh) > maxFollowLineBytes {
					want += followLineMarker
				}
				if got := recvLine(t, lines, 2*time.Second); got != want {
					t.Fatal("old generation prefix leaked")
				}
			})
		}
	}
}

func TestFollowFileMissingPathAndClosedTicks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "later")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ticks := make(chan time.Time)
	stops := 0
	lines := followFileTicks(ctx, path, ticks, func() { stops++ })
	followTestTick(t, ticks)
	followTestTick(t, ticks)
	if err := os.WriteFile(path, []byte("created\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var got string
	select {
	case ticks <- time.Now():
		got = recvLine(t, lines, 2*time.Second)
	case got = <-lines:
	case <-time.After(2 * time.Second):
		t.Fatal("new path not observed")
	}
	if got != "created" {
		t.Fatalf("created line=%q", got)
	}
	close(ticks)
	select {
	case _, ok := <-lines:
		if ok {
			t.Fatal("unexpected line after tick closure")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("closed tick channel caused busy loop")
	}
	if stops != 1 {
		t.Fatalf("stop calls=%d", stops)
	}
}

func TestFollowFileCancellationReleasesBlockedDescriptor(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ticks := make(chan time.Time, 1)
	lines := followFileTicks(ctx, path, ticks, func() {})
	appendLine(t, path, strings.Repeat("line\n", 10000))
	ticks <- time.Now()
	if got := recvLine(t, lines, 2*time.Second); got != "line" {
		t.Fatalf("first line=%q", got)
	}
	cancel()
	timeout := time.After(2 * time.Second)
	for {
		select {
		case _, ok := <-lines:
			if !ok {
				entries, err := os.ReadDir("/proc/self/fd")
				if err != nil {
					t.Fatal(err)
				}
				for _, entry := range entries {
					if target, _ := os.Readlink("/proc/self/fd/" + entry.Name()); target == path {
						t.Fatal("cancelled follower leaked its file descriptor")
					}
				}
				return
			}
		case <-timeout:
			t.Fatal("blocked follower did not cancel")
		}
	}
}

func TestFollowFileRetainsPendingPrefixDuringTemporaryAbsence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ticks := make(chan time.Time)
	lines := followFileTicks(ctx, path, ticks, func() {})
	appendLine(t, path, "pending")
	followTestTick(t, ticks)
	followTestTick(t, ticks)
	if err := os.Rename(path, path+".away"); err != nil {
		t.Fatal(err)
	}
	followTestTick(t, ticks)
	followTestTick(t, ticks)
	if err := os.Rename(path+".away", path); err != nil {
		t.Fatal(err)
	}
	appendLine(t, path, " finished\n")
	var got string
	select {
	case ticks <- time.Now():
		got = recvLine(t, lines, 2*time.Second)
	case got = <-lines:
	case <-time.After(2 * time.Second):
		t.Fatal("restored file not read")
	}
	if got != "pending finished" {
		t.Fatalf("temporary absence lost pending prefix: %q", got)
	}
}

func TestReadNewLinesAndOverlapUseOpenedDescriptor(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log")
	if err := os.WriteFile(path, []byte("old\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path, path+".old"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("replacement\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var cursor fileFollowCursor
	var got []string
	if err := readNewLines(context.Background(), f, fi.Size(), &cursor, make([]byte, followChunkBytes), func(line string) bool { got = append(got, line); return true }); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(got, []string{"old"}) || !overlapStillMatches(f, cursor.offset, []byte("old\n")) {
		t.Fatal("growth and overlap reads switched to the replacement path")
	}
}

func TestSyslogOversizedFilterUsesSourcePrefixNotMarker(t *testing.T) {
	for _, service := range []string{"telemt", "truncated"} {
		t.Run(service, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "syslog")
			if err := os.WriteFile(path, nil, 0o600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			lines, err := NewSyslog(path, time.Millisecond).Stream(ctx, service)
			if err != nil {
				t.Fatal(err)
			}
			header := "Thu Jan  1 00:00:11 1970 "
			if service == "telemt" {
				appendLine(t, path, header+"telemt[9]: "+strings.Repeat("x", maxFollowLineBytes)+"\n")
				first := recvLine2(t, lines, 2*time.Second)
				if first.Unit != "telemt" || !strings.HasSuffix(first.Msg, followLineMarker) {
					t.Fatal("matched prefix did not preserve parsed unit and truncation marker")
				}
			}
			appendLine(t, path, header+"panel[9]: "+strings.Repeat("x", maxFollowLineBytes)+" "+service+"\n"+header+service+"[9]: done\n")
			got := recvLine2(t, lines, 2*time.Second)
			if got.Unit != service || got.Msg != "done" {
				t.Fatalf("discarded suffix or synthetic marker matched service: unit=%q message bytes=%d", got.Unit, len(got.Msg))
			}
		})
	}
}
