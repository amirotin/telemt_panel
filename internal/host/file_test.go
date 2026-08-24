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

// TestFollowFile_HandlesCopytruncateRefillWithinOneTick covers Finding 2:
// a same-inode truncate-then-refill that completes entirely between two
// poll ticks, ending with the file LARGER than the old offset again — the
// plain size<offset check alone can't catch this (by the time the next
// tick observes the file, its size is back at or past the old offset,
// just with different bytes there), so it must be caught by the
// content-overlap check in followFileTicks instead. Driven through
// followFileTicks directly with a manually-controlled tick channel — the
// poll interval is effectively paused, since nothing ticks until this
// test sends on tickCh — so the truncate+refill is deterministically
// complete before the single forced tick is even processed, with no
// reliance on real-time races.
func TestFollowFile_HandlesCopytruncateRefillWithinOneTick(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "log.txt")
	initial := "aaaa\nbbbb\ncccc\n"
	if err := os.WriteFile(path, []byte(initial), 0o644); err != nil {
		t.Fatal(err)
	}

	tickCh := make(chan time.Time)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch := followFileTicks(ctx, path, tickCh, func() {})

	// Truncate to 0 then immediately refill via the same path (same
	// inode — os.WriteFile opens the existing file rather than
	// create+rename, so rotation's inode check doesn't fire either) with
	// content longer than the old offset, before any tick has run.
	if err := os.Truncate(path, 0); err != nil {
		t.Fatal(err)
	}
	newContent := "NEW1\nNEW2\nNEW3\nNEW4\n"
	if len(newContent) <= len(initial) {
		t.Fatalf("test fixture bug: newContent (%d bytes) must be longer than initial (%d bytes) to exercise the bug", len(newContent), len(initial))
	}
	if err := os.WriteFile(path, []byte(newContent), 0o644); err != nil {
		t.Fatal(err)
	}

	select {
	case tickCh <- time.Now():
	case <-time.After(2 * time.Second):
		t.Fatal("followFileTicks never reached its tick wait")
	}

	want := []string{"NEW1", "NEW2", "NEW3", "NEW4"}
	for _, w := range want {
		got := recvLine(t, ch, 2*time.Second)
		if got != w {
			t.Fatalf("got %q, want %q — must restart from the top of the rewritten content, no stale/corrupted line from the old offset", got, w)
		}
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
	content := "Thu Jan  1 00:00:10 1970 daemon.info telemt[1]: telemt line one\n" +
		"Thu Jan  1 00:00:11 1970 daemon.info panel[2]: panel line one\n" +
		"Thu Jan  1 00:00:12 1970 telemt[1]: telemt line two, no severity token\n" +
		"Thu Jan  1 00:00:13 1970 daemon.info other[3]: unrelated\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	s := NewSyslog(path, time.Millisecond)

	got, err := s.Tail(context.Background(), "telemt", 10)
	if err != nil {
		t.Fatalf("Tail: %v", err)
	}
	want := []LogLine{
		{TS: mustParseANSIC(t, "Thu Jan  1 00:00:10 1970"), Level: "info", Unit: "telemt", Msg: "telemt line one"},
		// The no-severity-token variant: still parses Unit/Msg correctly,
		// Level falls back to "unknown" rather than misreading the tag.
		{TS: mustParseANSIC(t, "Thu Jan  1 00:00:12 1970"), Level: "unknown", Unit: "telemt", Msg: "telemt line two, no severity token"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d lines, want %d (only telemt-tagged): %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("line %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestSyslog_Tail_TrimsToRequestedCount(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "syslog")
	content := "Thu Jan  1 00:00:10 1970 daemon.info telemt[1]: a\n" +
		"Thu Jan  1 00:00:11 1970 daemon.info telemt[1]: b\n" +
		"Thu Jan  1 00:00:12 1970 daemon.info telemt[1]: c\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	s := NewSyslog(path, time.Millisecond)

	got, err := s.Tail(context.Background(), "telemt", 2)
	if err != nil {
		t.Fatalf("Tail: %v", err)
	}
	want := []LogLine{
		{TS: mustParseANSIC(t, "Thu Jan  1 00:00:11 1970"), Level: "info", Unit: "telemt", Msg: "b"},
		{TS: mustParseANSIC(t, "Thu Jan  1 00:00:12 1970"), Level: "info", Unit: "telemt", Msg: "c"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d lines, want %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("line %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestSyslog_Stream_FiltersByTag(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "syslog")
	if err := os.WriteFile(path, []byte("Thu Jan  1 00:00:09 1970 daemon.info preexisting[1]: x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := NewSyslog(path, 5*time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch, err := s.Stream(ctx, "telemt")
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}

	appendLine(t, path, "Thu Jan  1 00:00:10 1970 daemon.info panel[9]: unrelated message, should be filtered out\n")
	appendLine(t, path, "Thu Jan  1 00:00:11 1970 telemt[9]: this one matches, no severity token\n")

	got := recvLine2(t, ch, 2*time.Second)
	want := LogLine{TS: mustParseANSIC(t, "Thu Jan  1 00:00:11 1970"), Level: "unknown", Unit: "telemt", Msg: "this one matches, no severity token"}
	if got != want {
		t.Fatalf("got %+v, want %+v (the telemt-tagged line, panel line filtered)", got, want)
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
