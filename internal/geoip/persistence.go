package geoip

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const manifestVersion = 1

type activeManifest struct {
	Version         int    `json:"version"`
	Source          Source `json:"source"`
	Directory       string `json:"directory"`
	ConfigHash      string `json:"config_hash"`
	LoadedEpochSecs int64  `json:"loaded_epoch_secs"`
	Databases       []Kind `json:"databases"`
}

func configHash(cfg Config) string {
	encoded, _ := json.Marshal(cfg)
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

type manifestPublicationError struct {
	err error
}

func (e *manifestPublicationError) Error() string { return e.err.Error() }
func (e *manifestPublicationError) Unwrap() error { return e.err }

func writeActiveManifest(ctx context.Context, root string, b *bundle, cfg Config, syncDir func(string) error) (string, error) {
	oldDir := ""
	if old, err := readManifest(root); err == nil && validManifestName(old.Directory, "bundle-") {
		oldDir = filepath.Join(root, old.Directory)
	}
	manifest := activeManifest{
		Version: manifestVersion, Source: b.source, Directory: filepath.Base(b.dir),
		ConfigHash: configHash(cfg), Databases: make([]Kind, 0, len(b.databases)),
	}
	for _, status := range b.statuses() {
		manifest.Databases = append(manifest.Databases, status.Kind)
		if status.LoadedEpochSecs > manifest.LoadedEpochSecs {
			manifest.LoadedEpochSecs = status.LoadedEpochSecs
		}
	}
	if !validManifest(manifest) {
		return "", errors.New("geoip: invalid active manifest")
	}
	temp, err := os.CreateTemp(root, ".active-")
	if err != nil {
		return "", err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return "", err
	}
	if err := json.NewEncoder(temp).Encode(manifest); err != nil {
		temp.Close()
		return "", err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return "", err
	}
	if err := temp.Close(); err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := os.Rename(tempPath, filepath.Join(root, "active.json")); err != nil {
		return "", err
	}
	if err := syncDir(root); err != nil {
		// The rename is visible but its crash outcome is uncertain. Retain
		// both bundles so either the old or the new manifest is recoverable.
		return "", &manifestPublicationError{err: err}
	}
	return oldDir, nil
}

func restoreActiveBundle(root string, cfg Config) (*bundle, bool, error) {
	manifest, err := readManifest(root)
	if err != nil {
		return nil, false, err
	}
	if !validManifest(manifest) {
		return nil, false, errors.New("geoip: invalid active manifest")
	}
	directory := filepath.Join(root, manifest.Directory)
	paths := make(map[Kind]string, len(manifest.Databases))
	for _, kind := range manifest.Databases {
		paths[kind] = filepath.Join(directory, string(kind)+".mmdb")
	}
	b, err := openBundle(paths, manifest.LoadedEpochSecs)
	if err != nil {
		return nil, false, err
	}
	b.dir = directory
	b.source = manifest.Source
	return b, manifest.ConfigHash == configHash(cfg), nil
}

func readManifest(root string) (activeManifest, error) {
	file, err := os.Open(filepath.Join(root, "active.json"))
	if err != nil {
		return activeManifest{}, err
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 64<<10))
	decoder.DisallowUnknownFields()
	var manifest activeManifest
	if err := decoder.Decode(&manifest); err != nil {
		return activeManifest{}, err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return activeManifest{}, errors.New("geoip: trailing manifest data")
	}
	return manifest, nil
}

func validManifest(manifest activeManifest) bool {
	if manifest.Version != manifestVersion || manifest.LoadedEpochSecs <= 0 ||
		!validManifestName(manifest.Directory, "bundle-") || len(manifest.Databases) == 0 ||
		len(manifest.ConfigHash) != sha256.Size*2 {
		return false
	}
	switch manifest.Source {
	case SourceCommunity, SourceURLs, SourceFiles:
	default:
		return false
	}
	seen := make(map[Kind]bool, len(manifest.Databases))
	for _, kind := range manifest.Databases {
		if seen[kind] || (kind != KindCountry && kind != KindASN && kind != KindCity) {
			return false
		}
		seen[kind] = true
	}
	return true
}

func validManifestName(name, prefix string) bool {
	return strings.HasPrefix(name, prefix) && name != prefix &&
		filepath.Base(name) == name && !strings.ContainsAny(name, `/\`)
}
