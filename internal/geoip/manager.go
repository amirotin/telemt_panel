package geoip

import (
	"container/list"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

const (
	configSettingKey = "geoip.config"
	cacheCapacity    = 4096
	maxDatabaseBytes = int64(128 << 20)

	// ErrorDataDirRequired through ErrorActivationFailed are stable status error codes.
	ErrorDataDirRequired   = "data_dir_required"
	ErrorSourceUnavailable = "source_unavailable"
	ErrorSourceNotRegular  = "source_not_regular"
	ErrorSourceTooLarge    = "source_too_large"
	ErrorDownloadFailed    = "download_failed"
	ErrorDownloadTooLarge  = "download_too_large"
	ErrorDatabaseInvalid   = "database_invalid"
	ErrorDatabaseType      = "database_type_mismatch"
	ErrorActivationFailed  = "activation_failed"
)

const (
	communityCountryURL = "https://github.com/P3TERX/GeoLite.mmdb/raw/download/GeoLite2-Country.mmdb"
	communityASNURL     = "https://github.com/P3TERX/GeoLite.mmdb/raw/download/GeoLite2-ASN.mmdb"
	communityCityURL    = "https://github.com/P3TERX/GeoLite.mmdb/raw/download/GeoLite2-City.mmdb"
)

// SettingsStore persists panel settings used by Manager.
type SettingsStore interface {
	GetSetting(string) (string, bool, error)
	SetSetting(string, string) error
}

type cacheItem struct {
	addr   netip.Addr
	result Result
}

// Manager owns GeoIP configuration, updates, readers, and lookup caching.
type Manager struct {
	dataDir  string
	store    SettingsStore
	client   downloader
	now      func() time.Time
	syncFile func(string) error
	syncDir  func(string) error

	mu          sync.RWMutex
	config      Config
	status      Status
	active      *bundle
	closed      bool
	operation   bool
	lastAttempt time.Time

	cacheMu    sync.Mutex
	cache      map[netip.Addr]*list.Element
	cacheOrder *list.List

	ctx       context.Context
	cancel    context.CancelFunc
	wg        sync.WaitGroup
	closeDone chan struct{}
}

// DisabledStatus returns the canonical unavailable disabled state.
func DisabledStatus() Status {
	return Status{State: StateDisabled, Databases: []DatabaseStatus{}}
}

// NewManager restores persisted configuration and the last verified bundle.
func NewManager(dataDir string, settingsStore SettingsStore) *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	m := &Manager{
		dataDir: dataDir, store: settingsStore, client: newSecureDownloader(),
		now: time.Now, syncFile: syncDatabaseFile, syncDir: syncDatabaseFile, config: DefaultConfig(), status: DisabledStatus(),
		cache: make(map[netip.Addr]*list.Element, cacheCapacity), cacheOrder: list.New(),
		ctx: ctx, cancel: cancel, closeDone: make(chan struct{}),
	}
	m.restore()
	return m
}

func (m *Manager) restore() {
	if m.store == nil {
		m.status = errorStatus(nil, ErrorActivationFailed)
		return
	}
	raw, ok, err := m.store.GetSetting(configSettingKey)
	if err != nil {
		m.status = errorStatus(nil, ErrorActivationFailed)
		return
	}
	if ok {
		decoder := json.NewDecoder(strings.NewReader(raw))
		decoder.DisallowUnknownFields()
		var cfg Config
		if err := decoder.Decode(&cfg); err != nil || cfg.Validate() != nil {
			m.status = errorStatus(nil, ErrorActivationFailed)
			return
		}
		var trailing any
		if err := decoder.Decode(&trailing); err != io.EOF {
			m.status = errorStatus(nil, ErrorActivationFailed)
			return
		}
		m.config = cfg
	}
	if !m.config.Enabled {
		m.status = DisabledStatus()
		return
	}
	if m.dataDir == "" {
		m.status = errorStatus(nil, ErrorDataDirRequired)
		return
	}
	b, matches, err := restoreActiveBundle(filepath.Join(m.dataDir, "geoip"), m.config)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			m.status = Status{State: StateEmpty, Databases: []DatabaseStatus{}}
		} else {
			m.status = errorStatus(nil, ErrorActivationFailed)
		}
		return
	}
	m.active = b
	if !matches {
		m.status = errorStatus(b, ErrorActivationFailed)
	} else {
		source := b.source
		m.status = Status{State: StateReady, Available: true, ActiveSource: &source, Databases: b.statuses()}
	}
}

func errorStatus(active *bundle, code string) Status {
	status := Status{State: StateError, Databases: []DatabaseStatus{}, LastError: &code}
	if active != nil {
		status.Available = true
		source := active.source
		status.ActiveSource = &source
		status.Databases = active.statuses()
	}
	return status
}

// Settings returns an atomic snapshot of desired configuration and runtime status.
func (m *Manager) Settings() Settings {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return Settings{Config: m.config, Status: m.statusLocked()}
}

// Status returns a copy of the current runtime status.
func (m *Manager) Status() Status {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.statusLocked()
}

func (m *Manager) statusLocked() Status {
	out := m.status
	out.Databases = append([]DatabaseStatus(nil), m.status.Databases...)
	if out.Databases == nil {
		out.Databases = []DatabaseStatus{}
	}
	if m.status.ActiveSource != nil {
		source := *m.status.ActiveSource
		out.ActiveSource = &source
	}
	if m.status.LastError != nil {
		code := *m.status.LastError
		out.LastError = &code
	}
	return out
}

// PutConfig validates and persists cfg, then asynchronously activates it when enabled.
func (m *Manager) PutConfig(cfg Config) (Settings, error) {
	if err := cfg.Validate(); err != nil {
		return m.Settings(), err
	}
	encoded, err := json.Marshal(cfg)
	if err != nil {
		return m.Settings(), errors.New("geoip: encode configuration")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Settings{Config: m.config, Status: m.statusLocked()}, errors.New("geoip: manager is closed")
	}
	if m.operation {
		return Settings{Config: m.config, Status: m.statusLocked()}, ErrBusy
	}
	if m.store == nil {
		return Settings{Config: m.config, Status: m.statusLocked()}, errors.New("geoip: settings store is unavailable")
	}
	if err := m.store.SetSetting(configSettingKey, string(encoded)); err != nil {
		return Settings{Config: m.config, Status: m.statusLocked()}, errors.New("geoip: persist configuration")
	}
	m.config = cfg
	if !cfg.Enabled {
		old := m.active
		m.active = nil
		m.clearCache()
		m.status = DisabledStatus()
		if old != nil {
			old.close()
		}
		return Settings{Config: m.config, Status: m.statusLocked()}, nil
	}
	m.startOperationLocked(cfg)
	return Settings{Config: m.config, Status: m.statusLocked()}, nil
}

// Update asynchronously rebuilds the active bundle from the persisted configuration.
func (m *Manager) Update() (Settings, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Settings{Config: m.config, Status: m.statusLocked()}, errors.New("geoip: manager is closed")
	}
	if !m.config.Enabled {
		return Settings{Config: m.config, Status: m.statusLocked()}, ErrDisabled
	}
	if m.operation {
		return Settings{Config: m.config, Status: m.statusLocked()}, ErrBusy
	}
	m.startOperationLocked(m.config)
	return Settings{Config: m.config, Status: m.statusLocked()}, nil
}

func (m *Manager) startOperationLocked(cfg Config) {
	m.operation = true
	m.lastAttempt = m.now()
	m.status.State = StateUpdating
	m.status.LastError = nil
	if m.status.Databases == nil {
		m.status.Databases = []DatabaseStatus{}
	}
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		next, oldDir, err := m.buildBundle(m.ctx, cfg)
		m.mu.Lock()
		defer m.mu.Unlock()
		m.operation = false
		if err != nil {
			if !m.closed {
				m.status = errorStatus(m.active, errorCode(err))
			}
			return
		}
		if m.closed {
			next.close()
			return
		}
		old := m.active
		m.active = next
		m.clearCache()
		source := next.source
		m.status = Status{State: StateReady, Available: true, ActiveSource: &source, Databases: next.statuses()}
		if old != nil {
			old.close()
		}
		if oldDir != "" && oldDir != next.dir {
			_ = os.RemoveAll(oldDir)
		}
	}()
}

// Lookup enriches one address from the active local bundle.
func (m *Manager) Lookup(rawIP string) *Result {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.lookupLocked(rawIP)
}

// LookupPage returns one status generation and matching results for a page of addresses.
func (m *Manager) LookupPage(ips []string) (Status, []*Result) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	status := m.statusLocked()
	results := make([]*Result, len(ips))
	for i, rawIP := range ips {
		results[i] = m.lookupLocked(rawIP)
	}
	return status, results
}

func (m *Manager) lookupLocked(rawIP string) *Result {
	if m.closed || m.active == nil {
		return nil
	}
	addr, err := netip.ParseAddr(rawIP)
	if err != nil {
		return nil
	}
	addr = addr.Unmap()
	if isNonPublic(addr) {
		return &Result{State: ResultPrivate}
	}
	m.cacheMu.Lock()
	if element := m.cache[addr]; element != nil {
		m.cacheOrder.MoveToFront(element)
		result := element.Value.(cacheItem).result
		m.cacheMu.Unlock()
		return &result
	}
	m.cacheMu.Unlock()
	result, err := m.active.lookup(addr)
	if err != nil {
		return &Result{State: ResultNotFound}
	}
	m.cacheMu.Lock()
	if element := m.cache[addr]; element != nil {
		m.cacheOrder.MoveToFront(element)
		result = element.Value.(cacheItem).result
	} else {
		element := m.cacheOrder.PushFront(cacheItem{addr: addr, result: result})
		m.cache[addr] = element
		if m.cacheOrder.Len() > cacheCapacity {
			last := m.cacheOrder.Back()
			delete(m.cache, last.Value.(cacheItem).addr)
			m.cacheOrder.Remove(last)
		}
	}
	m.cacheMu.Unlock()
	return &result
}

var carrierGradeNAT = netip.MustParsePrefix("100.64.0.0/10")

func isNonPublic(addr netip.Addr) bool {
	return !addr.IsValid() || addr.IsPrivate() || addr.IsLoopback() ||
		addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast() ||
		addr.IsMulticast() || addr.IsUnspecified() ||
		(addr.Is4() && carrierGradeNAT.Contains(addr))
}

func (m *Manager) clearCache() {
	m.cacheMu.Lock()
	m.cache = make(map[netip.Addr]*list.Element, cacheCapacity)
	m.cacheOrder.Init()
	m.cacheMu.Unlock()
}

// Run checks scheduled refreshes until ctx is canceled or the manager is closed.
func (m *Manager) Run(ctx context.Context) {
	for {
		if m.refreshDue() {
			_, _ = m.Update()
		}
		timer := time.NewTimer(time.Hour)
		select {
		case <-ctx.Done():
			timer.Stop()
			m.Close()
			return
		case <-m.ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (m *Manager) refreshDue() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.closed || m.operation || !m.config.Enabled || m.config.Source == SourceFiles || m.config.Schedule == ScheduleManual {
		return false
	}
	interval := 7 * 24 * time.Hour
	if m.config.Schedule == ScheduleDaily {
		interval = 24 * time.Hour
	}
	baseline := m.lastAttempt
	for _, db := range m.status.Databases {
		loaded := time.Unix(db.LoadedEpochSecs, 0)
		if loaded.After(baseline) {
			baseline = loaded
		}
	}
	return baseline.IsZero() || !m.now().Before(baseline.Add(interval))
}

// Close cancels active work, waits for it, and closes database readers.
func (m *Manager) Close() {
	m.mu.Lock()
	if m.closed {
		done := m.closeDone
		m.mu.Unlock()
		<-done
		return
	}
	m.closed = true
	m.cancel()
	m.mu.Unlock()
	m.wg.Wait()
	m.mu.Lock()
	if m.active != nil {
		m.active.close()
		m.active = nil
	}
	m.clearCache()
	m.mu.Unlock()
	close(m.closeDone)
}

func copyRegularFile(ctx context.Context, src, dst string) error {
	info, err := os.Lstat(src)
	if err != nil {
		return coded(ErrorSourceUnavailable, err)
	}
	if !info.Mode().IsRegular() {
		return coded(ErrorSourceNotRegular, nil)
	}
	if info.Size() > maxDatabaseBytes {
		return coded(ErrorSourceTooLarge, nil)
	}
	fd, err := unix.Open(src, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return coded(ErrorSourceUnavailable, err)
	}
	in := os.NewFile(uintptr(fd), "geoip-source")
	defer in.Close()
	current, err := in.Stat()
	if err != nil || !current.Mode().IsRegular() {
		return coded(ErrorSourceNotRegular, err)
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o400)
	if err != nil {
		return coded(ErrorActivationFailed, err)
	}
	n, copyErr := copyWithContext(ctx, out, io.LimitReader(in, maxDatabaseBytes+1))
	closeErr := out.Close()
	if copyErr != nil {
		return coded(ErrorSourceUnavailable, copyErr)
	}
	if closeErr != nil {
		return coded(ErrorActivationFailed, closeErr)
	}
	if n > maxDatabaseBytes {
		return coded(ErrorSourceTooLarge, nil)
	}
	return nil
}

func syncDatabaseFile(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	syncErr := file.Sync()
	closeErr := file.Close()
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}

func copyWithContext(ctx context.Context, dst io.Writer, src io.Reader) (int64, error) {
	buffer := make([]byte, 64<<10)
	var total int64
	for {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		n, readErr := src.Read(buffer)
		if n > 0 {
			written, writeErr := dst.Write(buffer[:n])
			total += int64(written)
			if writeErr != nil {
				return total, writeErr
			}
			if written != n {
				return total, io.ErrShortWrite
			}
		}
		if readErr == io.EOF {
			return total, nil
		}
		if readErr != nil {
			return total, readErr
		}
	}
}

type codeError struct {
	code string
	err  error
}

func (e *codeError) Error() string { return "geoip: " + e.code }
func (e *codeError) Unwrap() error { return e.err }

func coded(code string, err error) error {
	return &codeError{code: code, err: err}
}

func errorCode(err error) string {
	var target *codeError
	if errors.As(err, &target) {
		return target.code
	}
	return ErrorActivationFailed
}

func databaseError(err error) error {
	if errors.Is(err, errDatabaseTypeMismatch) {
		return coded(ErrorDatabaseType, err)
	}
	return coded(ErrorDatabaseInvalid, err)
}

func (m *Manager) buildBundle(ctx context.Context, cfg Config) (*bundle, string, error) {
	if m.dataDir == "" {
		return nil, "", coded(ErrorDataDirRequired, nil)
	}
	root := filepath.Join(m.dataDir, "geoip")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, "", coded(ErrorActivationFailed, err)
	}
	if err := m.syncDir(m.dataDir); err != nil {
		return nil, "", coded(ErrorActivationFailed, err)
	}
	staging, err := os.MkdirTemp(root, ".staging-")
	if err != nil {
		return nil, "", coded(ErrorActivationFailed, err)
	}
	keepStaging := false
	defer func() {
		if !keepStaging {
			_ = os.RemoveAll(staging)
		}
	}()
	paths := make(map[Kind]string)
	for _, item := range cfg.databases() {
		if !item.config.Enabled {
			continue
		}
		destination := filepath.Join(staging, string(item.kind)+".mmdb")
		switch cfg.Source {
		case SourceFiles:
			err = copyRegularFile(ctx, item.config.Location, destination)
		case SourceURLs, SourceCommunity:
			location := item.config.Location
			if cfg.Source == SourceCommunity {
				location = communityURL(item.kind)
			}
			err = m.client.download(ctx, location, destination)
		}
		if err != nil {
			return nil, "", err
		}
		if err := m.syncFile(destination); err != nil {
			return nil, "", coded(ErrorActivationFailed, err)
		}
		paths[item.kind] = destination
	}
	loadedAt := m.now().Unix()
	checked, err := openBundle(paths, loadedAt)
	if err != nil {
		return nil, "", databaseError(err)
	}
	checked.close()
	if err := m.syncDir(staging); err != nil {
		return nil, "", coded(ErrorActivationFailed, err)
	}
	if err := ctx.Err(); err != nil {
		return nil, "", coded(ErrorSourceUnavailable, err)
	}
	final := filepath.Join(root, "bundle-"+strings.TrimPrefix(filepath.Base(staging), ".staging-"))
	if err := os.Rename(staging, final); err != nil {
		return nil, "", coded(ErrorActivationFailed, err)
	}
	keepStaging = true
	if err := m.syncDir(root); err != nil {
		_ = os.RemoveAll(final)
		return nil, "", coded(ErrorActivationFailed, err)
	}
	finalPaths := make(map[Kind]string, len(paths))
	for kind := range paths {
		finalPaths[kind] = filepath.Join(final, string(kind)+".mmdb")
	}
	next, err := openBundle(finalPaths, loadedAt)
	if err != nil {
		_ = os.RemoveAll(final)
		return nil, "", databaseError(err)
	}
	next.dir = final
	next.source = cfg.Source
	if err := ctx.Err(); err != nil {
		next.close()
		_ = os.RemoveAll(final)
		return nil, "", coded(ErrorSourceUnavailable, err)
	}
	oldDir, err := writeActiveManifest(ctx, root, next, cfg, m.syncDir)
	if err != nil {
		next.close()
		var published *manifestPublicationError
		if !errors.As(err, &published) {
			_ = os.RemoveAll(final)
		}
		return nil, "", coded(ErrorActivationFailed, err)
	}
	return next, oldDir, nil
}

func communityURL(kind Kind) string {
	switch kind {
	case KindCountry:
		return communityCountryURL
	case KindASN:
		return communityASNURL
	case KindCity:
		return communityCityURL
	default:
		return ""
	}
}
