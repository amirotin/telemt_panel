package host

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestFileStreamStartsWithExistingLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "telemt.log")
	if err := os.WriteFile(path, []byte("first\nsecond\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events, err := NewFile(path, time.Hour).Stream(ctx, "S99telemt")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"first", "second"} {
		got := recvLine2(t, events, time.Second)
		if got.Msg != want || got.Unit != "S99telemt" || got.Level != "unknown" {
			t.Fatalf("line = %+v, want %q for S99telemt", got, want)
		}
	}
}

func TestFileStreamHistoryContinuesWithoutGapOrDuplicates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "telemt.log")
	if err := os.WriteFile(path, []byte("same\nsame\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events, err := NewFile(path, time.Millisecond).Stream(ctx, "telemt")
	if err != nil {
		t.Fatal(err)
	}

	// Write before consuming history, while the initial delivery is blocked.
	appendLine(t, path, "during-connect\n")
	for _, want := range []string{"same", "same", "during-connect"} {
		if got := recvLine2(t, events, time.Second); got.Msg != want {
			t.Fatalf("line = %q, want %q", got.Msg, want)
		}
	}
	appendLine(t, path, "after-history\n")
	if got := recvLine2(t, events, time.Second); got.Msg != "after-history" {
		t.Fatalf("line = %q, want after-history without replay", got.Msg)
	}
}

func TestFileStreamHistoryKeepsLast200CompleteLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "telemt.log")
	var content strings.Builder
	for i := 1; i <= 205; i++ {
		fmt.Fprintf(&content, "line-%03d\n", i)
	}
	content.WriteString("pending")
	if err := os.WriteFile(path, []byte(content.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events, err := NewFile(path, time.Millisecond).Stream(ctx, "telemt")
	if err != nil {
		t.Fatal(err)
	}
	for i := 6; i <= 205; i++ {
		want := fmt.Sprintf("line-%03d", i)
		if got := recvLine2(t, events, time.Second); got.Msg != want {
			t.Fatalf("line = %q, want %q", got.Msg, want)
		}
	}
	appendLine(t, path, "-complete\n")
	if got := recvLine2(t, events, time.Second); got.Msg != "pending-complete" {
		t.Fatalf("line = %q, want pending-complete", got.Msg)
	}
}

func TestFileStreamHistoryDropsClippedFirstLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "telemt.log")
	content := strings.Repeat("x", 300*1024) + "\nrecent-one\nrecent-two\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events, err := NewFile(path, time.Hour).Stream(ctx, "telemt")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"recent-one", "recent-two"} {
		if got := recvLine2(t, events, time.Second); got.Msg != want {
			t.Fatalf("line = %q, want %q", got.Msg, want)
		}
	}
}

func TestFileStreamCompletesExistingPartialLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "telemt.log")
	if err := os.WriteFile(path, []byte("pending"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events, err := NewFile(path, time.Millisecond).Stream(ctx, "telemt")
	if err != nil {
		t.Fatal(err)
	}
	appendLine(t, path, "-complete\nnext\n")
	for _, want := range []string{"pending-complete", "next"} {
		if got := recvLine2(t, events, time.Second); got.Msg != want {
			t.Fatalf("line = %q, want %q", got.Msg, want)
		}
	}
}

func TestFileStreamDiscardsClippedPartialLineUntilNewline(t *testing.T) {
	path := filepath.Join(t.TempDir(), "telemt.log")
	if err := os.WriteFile(path, []byte(strings.Repeat("x", 300*1024)), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events, err := NewFile(path, time.Millisecond).Stream(ctx, "telemt")
	if err != nil {
		t.Fatal(err)
	}
	appendLine(t, path, "unfinished suffix\nnext complete line\n")
	if got := recvLine2(t, events, time.Second); got.Msg != "next complete line" {
		t.Fatalf("line = %q, want next complete line without clipped suffix", got.Msg)
	}
	appendLine(t, path, "later line\n")
	if got := recvLine2(t, events, time.Second); got.Msg != "later line" {
		t.Fatalf("line = %q, want later line", got.Msg)
	}
}

func TestFileStreamHistoryCancelsBlockedDelivery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "telemt.log")
	if err := os.WriteFile(path, []byte(strings.Repeat("old\n", 200)), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events, err := NewFile(path, time.Hour).Stream(ctx, "telemt")
	if err != nil {
		t.Fatal(err)
	}
	recvLine2(t, events, time.Second)
	cancel()
	deadline := time.After(time.Second)
	for {
		select {
		case _, open := <-events:
			if !open {
				return
			}
		case <-deadline:
			t.Fatal("history delivery did not stop after cancellation")
		}
	}
}
