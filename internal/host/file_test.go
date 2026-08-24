package host

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// recvLine waits up to timeout for the next string off ch.
func recvLine(t *testing.T, ch <-chan string, timeout time.Duration) string {
	t.Helper()
	select {
	case s, ok := <-ch:
		if !ok {
			t.Fatal("channel closed unexpectedly")
		}
		return s
	case <-time.After(timeout):
		t.Fatal("timed out waiting for a line")
	}
	panic("unreachable")
}

func TestTailFileLines(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "log.txt")
	content := "line1\nline2\nline3\nline4\nline5\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := tailFileLines(path, 2)
	if err != nil {
		t.Fatalf("tailFileLines: %v", err)
	}
	want := []string{"line4", "line5"}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("got = %v, want %v", got, want)
	}
}

func TestTailFileLines_MoreLinesRequestedThanPresent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "log.txt")
	if err := os.WriteFile(path, []byte("only\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := tailFileLines(path, 100)
	if err != nil {
		t.Fatalf("tailFileLines: %v", err)
	}
	if len(got) != 1 || got[0] != "only" {
		t.Fatalf("got = %v, want [only]", got)
	}
}

func TestTailFileLines_NoTrailingNewline(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "log.txt")
	if err := os.WriteFile(path, []byte("a\nb\nc"), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := tailFileLines(path, 10)
	if err != nil {
		t.Fatalf("tailFileLines: %v", err)
	}
	want := []string{"a", "b", "c"}
	if len(got) != 3 || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("got = %v, want %v", got, want)
	}
}

func TestTailFileLines_EmptyFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "log.txt")
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := tailFileLines(path, 10)
	if err != nil {
		t.Fatalf("tailFileLines: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("got = %v, want empty", got)
	}
}

func TestTailFileLines_BoundedByMaxBytesDropsPartialFirstLine(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "log.txt")
	// Build a file bigger than maxTailBytes where every line has a known,
	// distinct, easily verifiable tail so the byte-bounded read's dropped
	// partial first line can be asserted precisely.
	var b strings.Builder
	lineLen := 100
	total := 0
	n := 0
	for total < maxTailBytes*2 {
		line := strings.Repeat("x", lineLen-10) + numberSuffix(n)
		b.WriteString(line)
		b.WriteByte('\n')
		total += len(line) + 1
		n++
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := tailFileLines(path, 3)
	if err != nil {
		t.Fatalf("tailFileLines: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d lines, want 3", len(got))
	}
	// The very last written line must be present and intact.
	last := got[len(got)-1]
	if !strings.HasSuffix(last, numberSuffix(n-1)) {
		t.Fatalf("last line = %q, want suffix %q", last, numberSuffix(n-1))
	}
}

func numberSuffix(n int) string { return "#" + string(rune('0'+n%10)) }

func TestTailFileLines_MissingFile(t *testing.T) {
	if _, err := tailFileLines("/nonexistent/path/does/not/exist.log", 10); err == nil {
		t.Fatal("expected error for a missing file")
	}
}

func TestFollowFile_EmitsOnlyNewCompleteLines(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "log.txt")
	if err := os.WriteFile(path, []byte("preexisting\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch := followFile(ctx, path, 5*time.Millisecond)

	appendLine(t, path, "one\n")
	if got := recvLine(t, ch, 2*time.Second); got != "one" {
		t.Fatalf("got %q, want one (preexisting content must not be re-emitted)", got)
	}

	// A partial line (no trailing newline yet) must not be emitted until
	// it's completed.
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("partial-no-newline-yet"); err != nil {
		t.Fatal(err)
	}
	f.Close()

	select {
	case got := <-ch:
		t.Fatalf("got %q before its newline arrived, want no emission yet", got)
	case <-time.After(50 * time.Millisecond):
	}

	appendLine(t, path, " now complete\n")
	if got := recvLine(t, ch, 2*time.Second); got != "partial-no-newline-yet now complete" {
		t.Fatalf("got %q, want the reassembled complete line", got)
	}

	cancel()
	for range ch {
	}
}

func TestFile_Tail(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "telemt.log")
	if err := os.WriteFile(path, []byte("a\nb\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	f := NewFile(path, time.Millisecond)

	got, err := f.Tail(context.Background(), "telemt", 10)
	if err != nil {
		t.Fatalf("Tail: %v", err)
	}
	if len(got) != 2 || got[0].Msg != "a" || got[1].Msg != "b" {
		t.Fatalf("got = %+v", got)
	}
	for _, l := range got {
		if l.Level != "unknown" || l.Unit != "telemt" {
			t.Errorf("line = %+v, want Level=unknown Unit=telemt", l)
		}
	}
}

func TestFile_Stream_EmitsAppendedLines(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "telemt.log")
	if err := os.WriteFile(path, []byte("preexisting\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	f := NewFile(path, 5*time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch, err := f.Stream(ctx, "telemt")
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}

	appendLine(t, path, "new line 1\n")
	got := recvLine2(t, ch, 2*time.Second)
	if got.Msg != "new line 1" {
		t.Fatalf("got %+v, want new line 1 (preexisting content must not be re-emitted)", got)
	}
}

func TestFile_Stream_HandlesTruncation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "telemt.log")
	if err := os.WriteFile(path, []byte("line1\nline2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	f := NewFile(path, 5*time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch, err := f.Stream(ctx, "telemt")
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}

	appendLine(t, path, "line3\n")
	if got := recvLine2(t, ch, 2*time.Second); got.Msg != "line3" {
		t.Fatalf("got %+v, want line3", got)
	}

	// Truncate (e.g. logrotate's copytruncate) then write fresh content
	// smaller than the old offset — the follower must reopen from 0
	// instead of waiting forever for the file to regrow past the old size.
	if err := os.Truncate(path, 0); err != nil {
		t.Fatal(err)
	}
	appendLine(t, path, "after-truncate\n")
	if got := recvLine2(t, ch, 2*time.Second); got.Msg != "after-truncate" {
		t.Fatalf("got %+v, want after-truncate", got)
	}
}

func TestFile_Stream_HandlesRotation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "telemt.log")
	if err := os.WriteFile(path, []byte("old content\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	f := NewFile(path, 5*time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch, err := f.Stream(ctx, "telemt")
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}

	// Simulate log rotation: move the old file aside and create a brand
	// new file (new inode) at the same path.
	if err := os.Rename(path, path+".1"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("rotated content\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if got := recvLine2(t, ch, 2*time.Second); got.Msg != "rotated content" {
		t.Fatalf("got %+v, want rotated content", got)
	}
}

func TestFile_Caps(t *testing.T) {
	caps := NewFile("/some/path", time.Second).Caps()
	if !caps.CanTail || !caps.CanStream {
		t.Errorf("caps = %+v, want both true", caps)
	}
}

func TestFile_Kind(t *testing.T) {
	if got := NewFile("/some/path", time.Second).Kind(); got != LogKindFile {
		t.Errorf("Kind() = %q, want %q", got, LogKindFile)
	}
}

func TestSyslog_Tail_FiltersByTag(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "syslog")
	content := "Jan 1 telemt[1]: telemt line one\n" +
		"Jan 1 panel[2]: panel line one\n" +
		"Jan 1 telemt[1]: telemt line two\n" +
		"Jan 1 other[3]: unrelated\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	s := NewSyslog(path, time.Millisecond)

	got, err := s.Tail(context.Background(), "telemt", 10)
	if err != nil {
		t.Fatalf("Tail: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d lines, want 2 (only telemt-tagged): %+v", len(got), got)
	}
	if !strings.Contains(got[0].Msg, "telemt line one") || !strings.Contains(got[1].Msg, "telemt line two") {
		t.Fatalf("got = %+v", got)
	}
}

func TestSyslog_Tail_TrimsToRequestedCount(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "syslog")
	content := "Jan 1 telemt[1]: a\nJan 1 telemt[1]: b\nJan 1 telemt[1]: c\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	s := NewSyslog(path, time.Millisecond)

	got, err := s.Tail(context.Background(), "telemt", 2)
	if err != nil {
		t.Fatalf("Tail: %v", err)
	}
	if len(got) != 2 || !strings.Contains(got[0].Msg, ": b") || !strings.Contains(got[1].Msg, ": c") {
		t.Fatalf("got = %+v, want the last 2 matching lines", got)
	}
}

func TestSyslog_Stream_FiltersByTag(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "syslog")
	if err := os.WriteFile(path, []byte("Jan 1 preexisting: x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := NewSyslog(path, 5*time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch, err := s.Stream(ctx, "telemt")
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}

	appendLine(t, path, "Jan 1 panel[9]: unrelated message, should be filtered out\n")
	appendLine(t, path, "Jan 1 telemt[9]: this one matches\n")

	got := recvLine2(t, ch, 2*time.Second)
	if !strings.Contains(got.Msg, "this one matches") {
		t.Fatalf("got %+v, want the telemt-tagged line (panel line must be filtered)", got)
	}
}

func TestSyslog_Caps(t *testing.T) {
	caps := NewSyslog("/var/log/syslog", time.Second).Caps()
	if !caps.CanTail || !caps.CanStream {
		t.Errorf("caps = %+v, want both true", caps)
	}
}

func TestSyslog_Kind(t *testing.T) {
	if got := NewSyslog("/var/log/syslog", time.Second).Kind(); got != LogKindSyslog {
		t.Errorf("Kind() = %q, want %q", got, LogKindSyslog)
	}
}

// appendLine appends s to the file at path, fataling the test on error.
func appendLine(t *testing.T, path, s string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(s); err != nil {
		t.Fatal(err)
	}
}

// recvLine2 waits up to timeout for the next LogLine off ch.
func recvLine2(t *testing.T, ch <-chan LogLine, timeout time.Duration) LogLine {
	t.Helper()
	select {
	case l, ok := <-ch:
		if !ok {
			t.Fatal("channel closed unexpectedly")
		}
		return l
	case <-time.After(timeout):
		t.Fatal("timed out waiting for a log line")
	}
	panic("unreachable")
}
