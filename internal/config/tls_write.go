package config

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/BurntSushi/toml"
)

// TLSCandidate is the complete transport proposal; omitted fields are cleared.
type TLSCandidate struct {
	Listen string    `json:"listen"`
	TLS    TLSConfig `json:"tls"`
}

// Normalize validates the web-editable transport, including HTTP listeners.
func (c *TLSCandidate) Normalize(defaultCache string) error {
	host, port, err := net.SplitHostPort(c.Listen)
	n, portErr := strconv.Atoi(port)
	if err != nil || portErr != nil || n < 1 || n > 65535 || strings.TrimSpace(c.Listen) != c.Listen || strings.IndexFunc(port, func(r rune) bool { return r < '0' || r > '9' }) != -1 {
		return errors.New("listen must be host:port with a numeric port between 1 and 65535")
	}
	if host != "" && net.ParseIP(host) == nil && host != "localhost" && !validACMEDomain(strings.ToLower(host)) {
		return errors.New("listen host must be an IP address, localhost or DNS hostname")
	}
	if c.TLS.Mode == "" {
		return errors.New("tls.mode is required")
	}
	if c.TLS.Mode == "acme" && c.TLS.AcmeCacheDir == "" {
		c.TLS.AcmeCacheDir = defaultCache
	}
	return c.TLS.Normalize(c.Listen, "")
}

// ErrTLSRevision means the operator changed the configuration since preparation.
var ErrTLSRevision = errors.New("configuration changed since preparation")

// TLSFile confines transport writes to one trusted startup file and directory.
type TLSFile struct {
	mu         sync.Mutex
	root       *os.Root
	path, name string
}

// TLSSnapshot is a validated disk configuration and its source revision.
type TLSSnapshot struct {
	Config   *Config
	Revision [32]byte
}

// OpenTLSFile rejects symlinks and pins the containing directory for atomic writes.
func OpenTLSFile(path string) (*TLSFile, error) {
	if path == "" {
		return nil, errors.New("startup config path is not configured")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil || real != abs {
		return nil, errors.New("config path must be a regular file without symlinks")
	}
	root, err := os.OpenRoot(filepath.Dir(abs))
	if err != nil {
		return nil, err
	}
	f := &TLSFile{root: root, path: abs, name: filepath.Base(abs)}
	if _, _, err := f.read(); err != nil {
		root.Close()
		return nil, err
	}
	return f, nil
}

// Close releases the pinned directory handle.
func (f *TLSFile) Close() error { return f.root.Close() }

func (f *TLSFile) read() ([]byte, *Config, error) {
	real, err := filepath.EvalSymlinks(f.path)
	if err != nil || real != f.path {
		return nil, nil, errors.New("config path changed or became a symlink")
	}
	info, err := f.root.Lstat(f.name)
	if err != nil || !info.Mode().IsRegular() {
		return nil, nil, errors.New("config must be a regular file")
	}
	current, err := os.Stat(f.path)
	if err != nil || !os.SameFile(info, current) {
		return nil, nil, ErrTLSRevision
	}
	file, err := f.root.Open(f.name)
	if err != nil {
		return nil, nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, nil, ErrTLSRevision
	}
	data, err := io.ReadAll(io.LimitReader(file, 1<<20+1))
	if err != nil || len(data) > 1<<20 {
		return nil, nil, errors.New("config is unreadable or too large")
	}
	cfg, err := decode(data, f.path)
	return data, cfg, err
}

// Read returns current disk state without changing the running configuration.
func (f *TLSFile) Read() (TLSSnapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	data, cfg, err := f.read()
	return TLSSnapshot{Config: cfg, Revision: sha256.Sum256(data)}, err
}

// Writable probes atomic-write permissions without changing configuration bytes.
func (f *TLSFile) Writable() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, _, err := f.read(); err != nil {
		return err
	}
	file, err := f.root.OpenFile(f.name, os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	name, err := f.stage(nil)
	if err != nil {
		return err
	}
	return f.root.Remove(name)
}

func (f *TLSFile) stage(data []byte) (string, error) {
	// CreateTemp cannot operate through Root; a random leaf name with O_EXCL
	// keeps creation within the pinned directory without following a link.
	for range 8 {
		name := ".panel-tls-" + randomName()
		file, err := f.root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		_, writeErr := file.Write(data)
		syncErr := file.Sync()
		closeErr := file.Close()
		if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
			_ = f.root.Remove(name)
			return "", err
		}
		return name, nil
	}
	return "", errors.New("cannot create temporary config")
}

func randomName() string {
	var value [16]byte
	_, _ = rand.Read(value[:])
	return hex.EncodeToString(value[:])
}

// Save atomically replaces listen/tls only, after validating the whole document.
// TOML comments/formatting are normalized; unrelated values and omissions survive.
func (f *TLSFile) Save(revision [32]byte, candidate TLSCandidate) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	before, _, err := f.read()
	if err != nil {
		return err
	}
	if sha256.Sum256(before) != revision {
		return ErrTLSRevision
	}
	if err := candidate.Normalize(""); err != nil {
		return err
	}
	var document map[string]any
	if _, err := toml.NewDecoder(bytes.NewReader(before)).Decode(&document); err != nil {
		return err
	}
	document["listen"] = candidate.Listen
	document["tls"] = candidate.TLS
	var encoded bytes.Buffer
	if err := toml.NewEncoder(&encoded).Encode(document); err != nil {
		return err
	}
	if _, err := decode(encoded.Bytes(), f.path); err != nil {
		return err
	}
	backup, err := f.stage(before)
	if err != nil {
		return err
	}
	defer f.root.Remove(backup)
	staged, err := f.stage(encoded.Bytes())
	if err != nil {
		return err
	}
	defer f.root.Remove(staged)
	latest, _, err := f.read()
	if err != nil {
		return err
	}
	if sha256.Sum256(latest) != revision {
		return ErrTLSRevision
	}
	if err := f.root.Rename(backup, f.name+".bak"); err != nil {
		return fmt.Errorf("save config backup: %w", err)
	}
	if err := f.root.Rename(staged, f.name); err != nil {
		return fmt.Errorf("replace config: %w", err)
	}
	return nil
}
