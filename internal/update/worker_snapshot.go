package update

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

type workerSnapshot struct {
	Path   string `json:"path"`
	Backup string `json:"backup,omitempty"`
	Exists bool   `json:"exists"`
	Mode   uint32 `json:"mode"`
	UID    int    `json:"uid"`
	GID    int    `json:"gid"`
}

func preflightWorkerSnapshots(paths []string) error {
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err == nil && !info.Mode().IsRegular() {
			return fmt.Errorf("snapshot source is not regular: %s", path)
		}
		probe, err := os.CreateTemp(filepath.Dir(path), ".update-restore-probe-*")
		if err != nil {
			return fmt.Errorf("cannot restore %s: %w", path, err)
		}
		if info != nil {
			stat, ok := info.Sys().(*syscall.Stat_t)
			if !ok {
				err = errors.New("snapshot ownership unavailable")
			} else {
				err = probe.Chown(int(stat.Uid), int(stat.Gid))
			}
		}
		err = errors.Join(err, probe.Close(), os.Remove(probe.Name()))
		if err != nil {
			return fmt.Errorf("cannot restore metadata of %s: %w", path, err)
		}
	}
	return nil
}

func copyWorkerFile(source, dest string, mode os.FileMode) (result error) {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("snapshot source is not regular: %s", source)
	}
	out, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, out.Close()) }()
	if _, err = io.Copy(out, in); err != nil {
		return err
	}
	return out.Sync()
}

func snapshotWorkerFiles(dir string, paths []string) ([]workerSnapshot, error) {
	backupDir := filepath.Join(dir, "snapshot")
	if err := os.MkdirAll(backupDir, 0o700); err != nil {
		return nil, err
	}
	result := make([]workerSnapshot, 0, len(paths))
	for i, path := range paths {
		snap := workerSnapshot{Path: path}
		info, err := os.Stat(path)
		if errors.Is(err, os.ErrNotExist) {
			result = append(result, snap)
			continue
		}
		if err != nil {
			return nil, err
		}
		snap.Exists = true
		snap.Mode = uint32(info.Mode().Perm())
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			return nil, errors.New("snapshot ownership unavailable")
		}
		snap.UID = int(stat.Uid)
		snap.GID = int(stat.Gid)
		snap.Backup = filepath.Join(backupDir, fmt.Sprintf("%d", i))
		if err := copyWorkerFile(path, snap.Backup, 0o600); err != nil {
			return nil, err
		}
		result = append(result, snap)
	}
	if err := syncWorkerDir(backupDir); err != nil {
		return nil, err
	}
	return result, nil
}

func restoreWorkerFiles(snapshots []workerSnapshot) error {
	for _, snap := range snapshots {
		if err := os.MkdirAll(filepath.Dir(snap.Path), 0o700); err != nil {
			return err
		}
		if !snap.Exists {
			if err := os.Remove(snap.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			if err := syncWorkerDir(filepath.Dir(snap.Path)); err != nil {
				return err
			}
			continue
		}
		tmp, err := os.CreateTemp(filepath.Dir(snap.Path), ".update-restore-*")
		if err != nil {
			return err
		}
		name := tmp.Name()
		if err = tmp.Close(); err != nil {
			os.Remove(name)
			return err
		}
		err = copyWorkerFile(snap.Backup, name, 0o600)
		if err == nil {
			err = os.Chown(name, snap.UID, snap.GID)
		}
		if err == nil {
			err = os.Chmod(name, os.FileMode(snap.Mode))
		}
		if err == nil {
			var f *os.File
			f, err = os.Open(name)
			if err == nil {
				err = errors.Join(f.Sync(), f.Close())
			}
		}
		if err == nil {
			err = os.Rename(name, snap.Path)
		}
		os.Remove(name)
		if err != nil {
			return err
		}
		if err := syncWorkerDir(filepath.Dir(snap.Path)); err != nil {
			return err
		}
	}
	return nil
}
