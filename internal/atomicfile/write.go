// Package atomicfile publishes ordinary files using a same-directory temporary file.
package atomicfile

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// PublicationError means new bytes are visible but directory durability failed.
type PublicationError struct{ Err error }

func (e *PublicationError) Error() string {
	return "file published but directory durability failed: " + e.Err.Error()
}
func (e *PublicationError) Unwrap() error { return e.Err }

// Published reports an error after the destination was atomically replaced.
func Published(err error) bool {
	var publication *PublicationError
	return errors.As(err, &publication)
}

type writeOps struct {
	syncFile  func(*os.File) error
	closeFile func(*os.File) error
	rename    func(string, string) error
	syncDir   func(string) error
}

func defaultOps() writeOps {
	return writeOps{syncFile: (*os.File).Sync, closeFile: (*os.File).Close, rename: os.Rename, syncDir: syncDirectory}
}

func syncDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	return errors.Join(dir.Sync(), dir.Close())
}

// Write atomically publishes a file and reports whether rename made it visible.
func Write(dest string, mode fs.FileMode, write func(io.Writer) error) (bool, error) {
	return writeWithOps(dest, mode, write, defaultOps())
}

func writeWithOps(dest string, mode fs.FileMode, write func(io.Writer) error, ops writeOps) (bool, error) {
	dir := filepath.Dir(dest)
	file, err := os.CreateTemp(dir, ".atomic-*")
	if err != nil {
		return false, fmt.Errorf("create temporary file: %w", err)
	}
	temp := file.Name()
	defer os.Remove(temp)
	defer file.Close()
	if err := file.Chmod(mode); err != nil {
		return false, fmt.Errorf("set temporary permissions: %w", err)
	}
	if err := write(file); err != nil {
		return false, fmt.Errorf("write temporary file: %w", err)
	}
	if err := ops.syncFile(file); err != nil {
		return false, fmt.Errorf("sync temporary file: %w", err)
	}
	if err := ops.closeFile(file); err != nil {
		return false, fmt.Errorf("close temporary file: %w", err)
	}
	if err := ops.rename(temp, dest); err != nil {
		return false, fmt.Errorf("publish temporary file: %w", err)
	}
	if err := ops.syncDir(dir); err != nil {
		return true, &PublicationError{Err: err}
	}
	return true, nil
}
