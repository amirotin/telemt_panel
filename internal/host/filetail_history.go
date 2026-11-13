package host

import (
	"bytes"
	"io"
	"os"
)

// fileHistoryOffset selects up to lines complete lines and a pending suffix
// from a bounded snapshot. The follower consumes them through its usual cursor.
// A clipped pending line must be discarded through its next newline.
func fileHistoryOffset(f *os.File, end int64, lines int) (offset int64, discardLine bool, err error) {
	start := max(int64(0), end-maxTailBytes)
	window := make([]byte, end-start)
	n, err := f.ReadAt(window, start)
	if err != nil && err != io.EOF {
		return 0, false, err
	}
	// Copytruncate can shrink the file after the captured end. Consume the
	// available bytes and let the follower's normal truncation checks recover.
	window = window[:n]
	first := 0
	if start > 0 {
		// A clipped leading line cannot be reconstructed from this window.
		newline := bytes.IndexByte(window, '\n')
		if newline < 0 {
			return end, true, nil
		}
		first = newline + 1
	}
	boundary := len(window)
	for remaining := lines; remaining >= 0; remaining-- {
		newline := bytes.LastIndexByte(window[first:boundary], '\n')
		if newline < 0 {
			break
		}
		boundary = first + newline
		if remaining == 0 {
			return start + int64(boundary+1), false, nil
		}
	}
	return start + int64(first), false, nil
}
