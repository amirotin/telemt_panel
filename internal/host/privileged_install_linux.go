package host

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/amirotin/telemt_panel/internal/atomicfile"
	"golang.org/x/sys/unix"
)

const maxPolicySize = 64 << 10

// LoadPrivilegedPolicy loads only a root-owned policy through protected parents.
func LoadPrivilegedPolicy(path string) (PrivilegedPolicy, error) {
	return loadPrivilegedPolicy(path, 0)
}

func loadPrivilegedPolicy(path string, owner uint32) (PrivilegedPolicy, error) {
	file, err := openFileNoFollow(path, owner, true)
	if err != nil {
		return PrivilegedPolicy{}, fmt.Errorf("open protected policy: %w", err)
	}
	defer file.Close()
	var stat unix.Stat_t
	if err := unix.Fstat(int(file.Fd()), &stat); err != nil {
		return PrivilegedPolicy{}, err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Uid != owner || stat.Mode&0o7777 != 0o600 || stat.Size > maxPolicySize {
		return PrivilegedPolicy{}, errors.New("policy must be a root-owned regular 0600 file of at most 64 KiB")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxPolicySize+1))
	if err != nil {
		return PrivilegedPolicy{}, err
	}
	if len(data) > maxPolicySize {
		return PrivilegedPolicy{}, errors.New("policy exceeds 64 KiB")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var policy PrivilegedPolicy
	if err := decoder.Decode(&policy); err != nil {
		return PrivilegedPolicy{}, fmt.Errorf("decode protected policy: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return PrivilegedPolicy{}, errors.New("protected policy has trailing JSON")
	}
	if policy.Version != 1 || len(policy.Binaries) != 2 || policy.Binaries["panel"] == "" || policy.Binaries["telemt"] == "" {
		return PrivilegedPolicy{}, errors.New("policy version 1 requires exactly panel and telemt binary targets")
	}
	for _, path := range []string{policy.StagingRoot, policy.Binaries["panel"], policy.Binaries["telemt"]} {
		if err := privilegedPath(path); err != nil {
			return PrivilegedPolicy{}, err
		}
	}
	if policy.Binaries["panel"] == policy.Binaries["telemt"] {
		return PrivilegedPolicy{}, errors.New("policy binary targets must be different")
	}
	fixed := make(map[string]bool, 6)
	physical := make(map[string]bool, 6)
	for _, target := range []string{"panel", "telemt"} {
		binary := policy.Binaries[target]
		for _, path := range []string{binary, binary + ".bak", filepath.Join(filepath.Dir(binary), ".telemt-panel-"+target+".lock")} {
			if fixed[path] {
				return PrivilegedPolicy{}, errors.New("policy binary, backup and target lock paths must be disjoint")
			}
			fixed[path] = true
			directory, err := openDirectoryNoFollow(filepath.Dir(path), owner, true)
			if err != nil {
				return PrivilegedPolicy{}, fmt.Errorf("policy fixed-path directory: %w", err)
			}
			var directoryStat unix.Stat_t
			err = unix.Fstat(int(directory.Fd()), &directoryStat)
			directory.Close()
			if err != nil {
				return PrivilegedPolicy{}, err
			}
			key := fmt.Sprintf("%d:%d:%s", directoryStat.Dev, directoryStat.Ino, filepath.Base(path))
			if physical[key] {
				return PrivilegedPolicy{}, errors.New("policy fixed paths alias the same directory entry")
			}
			physical[key] = true
		}
	}
	for _, binary := range policy.Binaries {
		directory, err := openDirectoryNoFollow(filepath.Dir(binary), owner, true)
		if err != nil {
			return PrivilegedPolicy{}, fmt.Errorf("policy binary directory: %w", err)
		}
		var existing unix.Stat_t
		err = unix.Fstatat(int(directory.Fd()), filepath.Base(binary), &existing, unix.AT_SYMLINK_NOFOLLOW)
		directory.Close()
		if err != nil && !errors.Is(err, unix.ENOENT) {
			return PrivilegedPolicy{}, err
		}
		if err == nil && (existing.Mode&unix.S_IFMT != unix.S_IFREG || existing.Uid != owner || existing.Mode&0o022 != 0) {
			return PrivilegedPolicy{}, errors.New("policy binary path must be a protected regular file")
		}
	}
	return policy, nil
}

func privilegedPath(path string) error {
	if path == "/" || !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return fmt.Errorf("privileged path %q must be normalized and absolute", path)
	}
	return nil
}

func trustedDirectory(fd int, owner uint32, exactOwner bool) error {
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFDIR || (stat.Uid != owner && (exactOwner || stat.Uid != 0)) {
		return errors.New("privileged directory must be root-owned")
	}
	if stat.Mode&0o022 != 0 && (exactOwner || stat.Uid != 0 || stat.Mode&unix.S_ISVTX == 0) {
		return errors.New("privileged directory is writable by group or others")
	}
	return nil
}

func openDirectoryNoFollow(path string, owner uint32, protected bool) (*os.File, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New("directory path must be normalized and absolute")
	}
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if path == "/" {
		parts = nil
	}
	for _, part := range parts {
		if protected {
			if err := trustedDirectory(fd, owner, false); err != nil {
				unix.Close(fd)
				return nil, err
			}
		}
		next, err := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		unix.Close(fd)
		if err != nil {
			return nil, err
		}
		fd = next
	}
	if protected {
		if err := trustedDirectory(fd, owner, true); err != nil {
			unix.Close(fd)
			return nil, err
		}
	}
	return os.NewFile(uintptr(fd), path), nil
}

func openFileNoFollow(path string, owner uint32, protected bool) (*os.File, error) {
	if err := privilegedPath(path); err != nil {
		return nil, err
	}
	directory, err := openDirectoryNoFollow(filepath.Dir(path), owner, protected)
	if err != nil {
		return nil, err
	}
	defer directory.Close()
	fd, err := unix.Openat(int(directory.Fd()), filepath.Base(path), unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), path), nil
}

// RunPrivilegedInstall performs one fixed policy operation in the root process.
func RunPrivilegedInstall(ctx context.Context, path, operation, target string) error {
	if os.Geteuid() != 0 {
		return errors.New("privileged installation requires root")
	}
	return runPrivilegedInstallOwner(ctx, path, operation, target, 0)
}

func runPrivilegedInstallOwner(ctx context.Context, path, operation, target string, owner uint32) error {
	if target != "panel" && target != "telemt" {
		return errors.New("privileged target must be panel or telemt")
	}
	if operation != "install" && operation != "backup" && operation != "restore" {
		return errors.New("privileged operation must be install, backup or restore")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	policy, err := loadPrivilegedPolicy(path, owner)
	if err != nil {
		return err
	}
	source, destination := filepath.Join(policy.StagingRoot, "runs", target, "bin"), policy.Binaries[target]
	if operation == "backup" {
		source = destination
		destination += ".bak"
	} else if operation == "restore" {
		source = destination + ".bak"
	}
	directory, err := openDirectoryNoFollow(filepath.Dir(destination), owner, true)
	if err != nil {
		return fmt.Errorf("open binary directory: %w", err)
	}
	defer directory.Close()
	lockFD, err := unix.Openat(int(directory.Fd()), ".telemt-panel-"+target+".lock", unix.O_RDWR|unix.O_CREAT|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0o600)
	if err != nil {
		return err
	}
	defer unix.Close(lockFD)
	var lockStat unix.Stat_t
	if err := unix.Fstat(lockFD, &lockStat); err != nil {
		return err
	}
	if lockStat.Mode&unix.S_IFMT != unix.S_IFREG || lockStat.Uid != owner || lockStat.Mode&0o7777 != 0o600 {
		return errors.New("unsafe privileged target lock")
	}
	if err := unix.Flock(lockFD, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		if errors.Is(err, unix.EWOULDBLOCK) {
			return ErrInstallInProgress
		}
		return err
	}
	var existing unix.Stat_t
	err = unix.Fstatat(int(directory.Fd()), filepath.Base(destination), &existing, unix.AT_SYMLINK_NOFOLLOW)
	if err != nil && !errors.Is(err, unix.ENOENT) {
		return err
	}
	if err == nil && (existing.Mode&unix.S_IFMT != unix.S_IFREG || existing.Uid != owner || existing.Mode&0o022 != 0) {
		return errors.New("unsafe existing binary destination")
	}
	file, err := openFileNoFollow(source, owner, operation != "install")
	if err != nil {
		return fmt.Errorf("open binary source: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > MaxBinaryCopySize {
		return errors.New("source must be a regular binary of at most 512 MiB")
	}
	return publishExecutableFD(ctx, file, directory, filepath.Base(destination), privilegedPublishOps{})
}

type privilegedPublishOps struct {
	syncFile func(*os.File) error
	rename   func(int, string, int, string) error
	syncDir  func(*os.File) error
}

func publishExecutableFD(ctx context.Context, source, directory *os.File, name string, ops privilegedPublishOps) error {
	if ops.syncFile == nil {
		ops.syncFile = (*os.File).Sync
	}
	if ops.rename == nil {
		ops.rename = unix.Renameat
	}
	if ops.syncDir == nil {
		ops.syncDir = (*os.File).Sync
	}
	var random [12]byte
	if _, err := rand.Read(random[:]); err != nil {
		return err
	}
	temp := ".telemt-panel-install-" + hex.EncodeToString(random[:])
	fd, err := unix.Openat(int(directory.Fd()), temp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(fd), temp)
	defer file.Close()
	defer unix.Unlinkat(int(directory.Fd()), temp, 0)
	copied, err := io.CopyBuffer(file, io.LimitReader(&contextBinaryReader{ctx: ctx, reader: source}, MaxBinaryCopySize+1), make([]byte, 32<<10))
	if err != nil {
		return err
	}
	if copied > MaxBinaryCopySize {
		return errors.New("binary exceeds 512 MiB copy cap")
	}
	if err := file.Chmod(0o755); err != nil {
		return err
	}
	if err := ops.syncFile(file); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := ops.rename(int(directory.Fd()), temp, int(directory.Fd()), name); err != nil {
		return err
	}
	if err := ops.syncDir(directory); err != nil {
		return &atomicfile.PublicationError{Err: err}
	}
	return nil
}

type contextBinaryReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextBinaryReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}
