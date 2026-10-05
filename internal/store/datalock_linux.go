package store

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	"golang.org/x/sys/unix"
)

// ErrDataDirInUse identifies another runtime/import owner of the data directory.
var ErrDataDirInUse = errors.New("data_dir_in_use")

// DataDirInUseError reports the directory whose runtime/import lock is held.
type DataDirInUseError struct{ DataDir string }

func (e *DataDirInUseError) Error() string {
	return fmt.Sprintf("data_dir_in_use: %s is owned by another runtime or import", e.DataDir)
}
func (e *DataDirInUseError) Unwrap() error { return ErrDataDirInUse }

type dataDirLock struct {
	file *os.File
	once sync.Once
	err  error
}

func (l *dataDirLock) Close() error { l.once.Do(func() { l.err = l.file.Close() }); return l.err }

// AcquireDataDirLock acquires exclusive nonblocking ownership of data_dir/.panel.lock.
func AcquireDataDirLock(dataDir string) (io.Closer, error) {
	if dataDir == "" {
		return nil, errors.New("data directory lock requires persistent data_dir")
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("prepare data directory lock: %w", err)
	}
	file, err := os.OpenFile(filepath.Join(dataDir, ".panel.lock"), os.O_RDWR|os.O_CREATE|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open data directory lock: %w", err)
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		if err == nil {
			err = errors.New("data directory lock must be a regular file")
		}
		return nil, err
	}
	if err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		file.Close()
		if errors.Is(err, unix.EWOULDBLOCK) {
			return nil, &DataDirInUseError{DataDir: dataDir}
		}
		return nil, fmt.Errorf("acquire data directory lock: %w", err)
	}
	return &dataDirLock{file: file}, nil
}
