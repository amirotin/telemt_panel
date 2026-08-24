package host

import (
	"context"
	"io"
	"os"
	"strings"
	"syscall"
	"time"
)

// maxTailBytes bounds how much of a file's tail tailFileLines reads,
// regardless of how many lines are requested — a syslog file can be many
// GB; reading only its last window keeps Tail cheap without ever reading
// the whole file just to return, say, the last 200 lines.
const maxTailBytes = 256 * 1024

// tailFileLines returns up to the last n lines of the file at path. It
// reads at most maxTailBytes from the end, so a request for more lines
// than that window holds returns fewer than n rather than reading the
// whole file.
func tailFileLines(path string, n int) ([]string, error) {
	if n <= 0 {
		return nil, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	size := fi.Size()
	readSize := size
	if readSize > maxTailBytes {
		readSize = maxTailBytes
	}

	var text string
	if readSize > 0 {
		buf := make([]byte, readSize)
		if _, err := f.ReadAt(buf, size-readSize); err != nil && err != io.EOF {
			return nil, err
		}
		text = string(buf)
	}
	if size > readSize {
		// The read window doesn't start at the file's beginning, so its
		// first line is possibly a partial line — drop it rather than
		// return a truncated line to the caller.
		if idx := strings.IndexByte(text, '\n'); idx >= 0 {
			text = text[idx+1:]
		} else {
			text = ""
		}
	}
	text = strings.TrimRight(text, "\n")
	if text == "" {
		return nil, nil
	}
	lines := strings.Split(text, "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines, nil
}

// linesToLogLines wraps raw text lines as LogLines: file/syslog sources
// carry no structured level information, so Level is always "unknown" and
// Msg is the line verbatim; Unit is the service the caller asked for,
// since that's the only association available (a shared syslog file has
// no per-line unit field the way journald does).
func linesToLogLines(raw []string, service string) []LogLine {
	out := make([]LogLine, len(raw))
	for i, line := range raw {
		out[i] = newLogLine(line, service)
	}
	return out
}

func newLogLine(line, service string) LogLine {
	return LogLine{Level: "unknown", Unit: service, Msg: line}
}

// followFile polls path for growth every pollInterval, emitting each new
// complete line as it appears; Stream only delivers new lines going
// forward (Tail already covers history), so it starts from the file's
// current end — captured synchronously here, before the polling goroutine
// starts, so a write landing right after the caller gets the channel back
// is never missed nor double-delivered (either race is possible if this
// snapshot were taken inside the goroutine instead, since its first tick
// isn't ordered against the caller's next write). Truncation (size shrinks
// — e.g. logrotate's copytruncate) and rotation (the file is replaced —
// different inode, e.g. rotate then create) are both handled by resuming
// from the new file's current content rather than re-emitting or erroring;
// a still-partial line at the end of the read window is held back and
// re-read whole once its newline arrives. The returned channel closes when
// ctx is done.
func followFile(ctx context.Context, path string, pollInterval time.Duration) <-chan string {
	var offset int64
	var ino uint64
	var haveIno bool
	if fi, err := os.Stat(path); err == nil {
		offset = fi.Size()
		ino, haveIno = fileIno(fi)
	}

	out := make(chan string)
	go func() {
		defer close(out)

		ticker := time.NewTicker(pollInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}

			fi, err := os.Stat(path)
			if err != nil {
				// Transient (e.g. mid-rotation, momentarily missing) —
				// retry on the next tick instead of ending the stream.
				continue
			}
			curIno, curHaveIno := fileIno(fi)
			rotated := haveIno && curHaveIno && curIno != ino
			truncated := fi.Size() < offset
			if rotated || truncated {
				offset = 0
			}
			ino, haveIno = curIno, curHaveIno

			if fi.Size() <= offset {
				continue
			}
			f, err := os.Open(path)
			if err != nil {
				continue
			}
			newOffset, lines := readNewLines(f, offset)
			f.Close()
			offset = newOffset

			for _, line := range lines {
				select {
				case out <- line:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return out
}

// fileIno extracts the inode number from a FileInfo on platforms where
// Sys() is a *syscall.Stat_t (true for the Linux hosts this panel targets);
// ok is false if that type assertion fails, and rotation detection is then
// skipped (truncation detection alone still catches the copytruncate case).
func fileIno(fi os.FileInfo) (ino uint64, ok bool) {
	sys, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return sys.Ino, true
}

// readNewLines reads f from offset to EOF and returns every complete
// (newline-terminated) line found, plus the offset just past the last one
// consumed. A trailing partial line (no newline yet) is left unconsumed —
// its bytes stay unread past the returned offset — so it's re-read whole
// once the writer finishes it.
func readNewLines(f *os.File, offset int64) (int64, []string) {
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return offset, nil
	}
	data, err := io.ReadAll(f)
	if err != nil || len(data) == 0 {
		return offset, nil
	}
	parts := strings.Split(string(data), "\n")
	complete := parts[:len(parts)-1] // last element is "" (ends in \n) or a partial line
	consumed := offset
	for _, line := range complete {
		consumed += int64(len(line)) + 1
	}
	return consumed, complete
}
