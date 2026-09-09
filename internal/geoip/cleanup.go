package geoip

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

const bundleMarkerName = ".telemt-panel-geoip.json"

type bundleMarker struct {
	Owner   string `json:"owner"`
	Version int    `json:"version"`
	ID      string `json:"id"`
}

func bundleID(name string) string {
	for _, prefix := range []string{".staging-", "bundle-"} {
		if validManifestName(name, prefix) {
			return strings.TrimPrefix(name, prefix)
		}
	}
	return ""
}

func writeBundleMarker(staging string) error {
	id := bundleID(filepath.Base(staging))
	if id == "" {
		return errors.New("geoip: invalid owned directory name")
	}
	f, err := os.OpenFile(filepath.Join(staging, bundleMarkerName), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := json.NewEncoder(f).Encode(bundleMarker{Owner: "telemt-panel.geoip", Version: 1, ID: id}); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	return f.Close()
}

// Cleanup assumes one panel process per data_dir. Uncertain ownership or paths
// preserve files; this is not a garbage collector for arbitrary MMDB directories.
func cleanupOwnedBundles(root string, cfg Config, active *bundle, only string) error {
	if active == nil {
		return nil
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil || resolved != abs {
		return err
	}
	fd, err := unix.Open(abs, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	dir := os.NewFile(uintptr(fd), abs)
	defer dir.Close()
	var rootInfo unix.Stat_t
	if err := unix.Fstat(fd, &rootInfo); err != nil {
		return err
	}
	if rootInfo.Uid != uint32(os.Geteuid()) || rootInfo.Mode&0o022 != 0 {
		return nil
	}
	manifest, err := readManifest(abs)
	if err != nil || !validManifest(manifest) {
		return err
	}
	activePath, err := filepath.Abs(active.dir)
	if err != nil {
		return err
	}
	if filepath.Join(abs, manifest.Directory) != activePath {
		return nil
	}
	var sources []string
	if cfg.Source == SourceFiles {
		for _, item := range cfg.databases() {
			if item.config.Location == "" {
				continue
			}
			// Cleaning '..' before resolving a symlink can change the source's
			// meaning. Ambiguous spellings must not authorize deletion.
			if filepath.Clean(item.config.Location) != item.config.Location {
				return nil
			}
			path, err := filepath.Abs(item.config.Location)
			if err != nil {
				return err
			}
			resolved, err := filepath.EvalSymlinks(path)
			if err != nil {
				return err
			}
			sources = append(sources, path, resolved)
		}
	}
	var names []string
	if only != "" {
		target, err := filepath.Abs(only)
		if err != nil {
			return err
		}
		if filepath.Dir(target) != abs {
			return nil
		}
		names = []string{filepath.Base(target)}
	} else {
		names, err = dir.Readdirnames(-1)
		if err != nil {
			return err
		}
	}
	for _, name := range names {
		if bundleID(name) == "" || name == manifest.Directory {
			continue
		}
		candidate := filepath.Join(abs, name)
		protected := false
		for _, source := range sources {
			rel, err := filepath.Rel(candidate, source)
			if err != nil {
				return err
			}
			if rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))) {
				protected = true
				break
			}
		}
		if protected {
			continue
		}
		// A failed candidate is left for a later startup; do not affect ready status.
		_ = removeOwnedBundle(fd, name)
	}
	return nil
}

func readBundleMarker(fd int, name string) ([]byte, error) {
	markerFD, err := unix.Openat(fd, bundleMarkerName, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(markerFD), bundleMarkerName)
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > 512 {
		return nil, errors.New("geoip: invalid ownership marker")
	}
	raw, err := io.ReadAll(io.LimitReader(f, 513))
	if err != nil {
		return nil, err
	}
	if len(raw) > 512 {
		return nil, errors.New("geoip: ownership marker too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var marker bundleMarker
	if err := decoder.Decode(&marker); err != nil {
		return nil, err
	}
	if marker.Owner != "telemt-panel.geoip" || marker.Version != 1 || marker.ID != bundleID(name) {
		return nil, errors.New("geoip: ownership mismatch")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, errors.New("geoip: trailing ownership data")
	}
	return raw, nil
}

func removeOwnedBundle(rootFD int, name string) error {
	fd, err := unix.Openat(rootFD, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	dir := os.NewFile(uintptr(fd), name)
	defer dir.Close()
	var identity unix.Stat_t
	if err := unix.Fstat(fd, &identity); err != nil {
		return err
	}
	if identity.Uid != uint32(os.Geteuid()) || identity.Mode&0o022 != 0 {
		return nil
	}
	marker, err := readBundleMarker(fd, name)
	if err != nil {
		return err
	}
	names, err := dir.Readdirnames(5)
	if err != nil && err != io.EOF {
		return err
	}
	if len(names) > 4 {
		return nil
	}
	for _, entry := range names {
		switch entry {
		case bundleMarkerName, "country.mmdb", "asn.mmdb", "city.mmdb":
		default:
			return nil
		}
		var info unix.Stat_t
		if err := unix.Fstatat(fd, entry, &info, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return err
		}
		if info.Mode&unix.S_IFMT != unix.S_IFREG {
			return nil
		}
	}
	var current unix.Stat_t
	if err := unix.Fstatat(rootFD, name, &current, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return err
	}
	if current.Dev != identity.Dev || current.Ino != identity.Ino {
		return nil
	}
	rechecked, err := readBundleMarker(fd, name)
	if err != nil {
		return err
	}
	if !bytes.Equal(marker, rechecked) {
		return nil
	}
	for _, entry := range names {
		if entry == bundleMarkerName {
			continue
		}
		if err := unix.Unlinkat(fd, entry, 0); err != nil {
			return err
		}
	}
	if err := unix.Unlinkat(fd, bundleMarkerName, 0); err != nil {
		return err
	}
	return unix.Unlinkat(rootFD, name, unix.AT_REMOVEDIR)
}

func (m *Manager) cleanupRestoredBundle(root string) {
	path := filepath.Join(root, "active.json")
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return
	}
	// Make the restored visible manifest durable before removing its predecessor.
	// A barrier failure does not make the verified readers unusable.
	if m.syncFile(path) != nil || m.syncDir(root) != nil {
		return
	}
	_ = cleanupOwnedBundles(root, m.config, m.active, "")
}
