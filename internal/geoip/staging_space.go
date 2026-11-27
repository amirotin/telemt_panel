package geoip

import (
	"context"
	"errors"
	"io"
	"math"
	"os"

	"golang.org/x/sys/unix"
)

// Leave space for the live database and control-plane writes while staging.
// On small filesystems the reserve scales down with the available capacity.
const maxStagingReserve = 32 << 20

func availableBytes(file *os.File) (int64, error) {
	var stat unix.Statfs_t
	if err := unix.Fstatfs(int(file.Fd()), &stat); err != nil {
		return 0, err
	}
	blockSize := stat.Frsize
	if blockSize == 0 {
		blockSize = stat.Bsize
	}
	if blockSize <= 0 {
		return 0, errors.New("geoip: filesystem reported an invalid block size")
	}
	if stat.Bavail > math.MaxInt64/uint64(blockSize) {
		return math.MaxInt64, nil
	}
	return int64(stat.Bavail) * int64(blockSize), nil
}

type stagingWriter struct {
	out        io.Writer
	available  func() (int64, error)
	reserve    int64
	remaining  int64
	untilCheck int64
}

func (w *stagingWriter) Write(p []byte) (int, error) {
	if w.untilCheck <= 0 {
		free, err := w.available()
		if err != nil {
			return 0, err
		}
		w.remaining = free - w.reserve
		w.untilCheck = 4 << 20
	}
	if int64(len(p)) > w.remaining {
		return 0, unix.ENOSPC
	}
	n, err := w.out.Write(p)
	w.remaining -= int64(n)
	w.untilCheck -= int64(n)
	return n, err
}

func stageDatabase(ctx context.Context, out *os.File, source io.Reader, size int64) error {
	available := func() (int64, error) { return availableBytes(out) }
	free, err := available()
	if err != nil {
		return err
	}
	reserve := min(free/16, int64(maxStagingReserve))
	if size > free-reserve {
		return unix.ENOSPC
	}
	writer := &stagingWriter{out: out, available: available, reserve: reserve, remaining: free - reserve, untilCheck: 4 << 20}
	return copyWithContext(ctx, writer, source)
}
