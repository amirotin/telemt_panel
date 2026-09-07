package geoip

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

type memorySettings struct {
	mu     sync.Mutex
	values map[string]string
	setErr error
}

func newMemorySettings() *memorySettings {
	return &memorySettings{values: make(map[string]string)}
}

func (s *memorySettings) GetSetting(key string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, ok := s.values[key]
	return value, ok, nil
}

func (s *memorySettings) SetSetting(key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.setErr != nil {
		return s.setErr
	}
	s.values[key] = value
	return nil
}

func fileConfig(country, asn, city string) Config {
	return Config{
		Enabled: true, Source: SourceFiles, Schedule: ScheduleWeekly,
		Country: DatabaseConfig{Enabled: country != "", Location: country},
		ASN:     DatabaseConfig{Enabled: asn != "", Location: asn},
		City:    DatabaseConfig{Enabled: city != "", Location: city},
	}
}

func waitState(t *testing.T, manager *Manager, state string) Status {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		status := manager.Status()
		if status.State == state {
			return status
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("status stayed %+v, want state %q", manager.Status(), state)
	return Status{}
}

func TestManagerAppliesAtomicallyPersistsAndRestores(t *testing.T) {
	dataDir := t.TempDir()
	settingsStore := newMemorySettings()
	manager := NewManager(dataDir, settingsStore)

	cfg := fileConfig(writeFixture(t, "country"), writeFixture(t, "asn"), writeFixture(t, "city"))
	settings, err := manager.PutConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if settings.Status.State != StateUpdating {
		t.Fatalf("accepted status = %+v", settings.Status)
	}
	status := waitState(t, manager, StateReady)
	if !status.Available || status.ActiveSource == nil || *status.ActiveSource != SourceFiles || len(status.Databases) != 3 || status.LastError != nil {
		t.Fatalf("ready status = %+v", status)
	}
	got := manager.Lookup("81.2.69.142")
	if got == nil || got.State != ResultFound || got.CountryCode != "GB" || got.City != "London" {
		t.Fatalf("lookup = %+v", got)
	}

	manager.Close()
	restored := NewManager(dataDir, settingsStore)
	defer restored.Close()
	status = restored.Status()
	if status.State != StateReady || !status.Available || len(status.Databases) != 3 {
		t.Fatalf("restored status = %+v", status)
	}
	got = restored.Lookup("::ffff:81.2.69.142")
	if got == nil || got.CountryCode != "GB" {
		t.Fatalf("restored lookup = %+v", got)
	}
}

func TestManagerFailedReplacementKeepsPreviousBundle(t *testing.T) {
	dataDir := t.TempDir()
	settingsStore := newMemorySettings()
	manager := NewManager(dataDir, settingsStore)
	defer manager.Close()
	good := fileConfig(writeFixture(t, "country"), "", "")
	if _, err := manager.PutConfig(good); err != nil {
		t.Fatal(err)
	}
	waitState(t, manager, StateReady)

	badPath := filepath.Join(t.TempDir(), "bad.mmdb")
	if err := os.WriteFile(badPath, []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.PutConfig(fileConfig(badPath, "", "")); err != nil {
		t.Fatal(err)
	}
	status := waitState(t, manager, StateError)
	if !status.Available || status.LastError == nil || *status.LastError != ErrorDatabaseInvalid {
		t.Fatalf("failed replacement status = %+v", status)
	}
	got := manager.Lookup("81.2.69.142")
	if got == nil || got.CountryCode != "GB" {
		t.Fatalf("failed replacement lost previous bundle: %+v", got)
	}
	manager.Close()
	restored := NewManager(dataDir, settingsStore)
	defer restored.Close()
	status = restored.Status()
	if status.State != StateError || !status.Available || status.LastError == nil || *status.LastError != ErrorActivationFailed {
		t.Fatalf("mismatched desired/active restart status = %+v", status)
	}
	if got := restored.Lookup("81.2.69.142"); got == nil || got.CountryCode != "GB" {
		t.Fatalf("restart did not retain last good bundle: %+v", got)
	}
}

func TestManagerSyncFailureKeepsPreviousBundle(t *testing.T) {
	manager := NewManager(t.TempDir(), newMemorySettings())
	defer manager.Close()
	good := fileConfig(writeFixture(t, "country"), "", "")
	if _, err := manager.PutConfig(good); err != nil {
		t.Fatal(err)
	}
	waitState(t, manager, StateReady)

	manager.syncFile = func(string) error { return errors.New("flush failed") }
	if _, err := manager.PutConfig(fileConfig(writeFixture(t, "country"), "", "")); err != nil {
		t.Fatal(err)
	}
	status := waitState(t, manager, StateError)
	if !status.Available || status.LastError == nil || *status.LastError != ErrorActivationFailed {
		t.Fatalf("flush failure status = %+v", status)
	}
	if got := manager.Lookup("81.2.69.142"); got == nil || got.CountryCode != "GB" {
		t.Fatalf("flush failure lost previous bundle: %+v", got)
	}
}

type blockingDownloader struct {
	started   chan struct{}
	cancelled chan struct{}
	release   chan struct{}
}

func (d *blockingDownloader) download(ctx context.Context, _, _ string) error {
	close(d.started)
	<-ctx.Done()
	close(d.cancelled)
	<-d.release
	return ctx.Err()
}

func TestConcurrentCloseCancelsAndWaitsForOperation(t *testing.T) {
	manager := NewManager(t.TempDir(), newMemorySettings())
	blocker := &blockingDownloader{started: make(chan struct{}), cancelled: make(chan struct{}), release: make(chan struct{})}
	manager.client = blocker
	cfg := Config{
		Enabled: true, Source: SourceURLs, Schedule: ScheduleManual,
		Country: DatabaseConfig{Enabled: true, Location: "https://example.test/country.mmdb"},
	}
	if _, err := manager.PutConfig(cfg); err != nil {
		t.Fatal(err)
	}
	<-blocker.started
	firstDone := make(chan struct{})
	secondDone := make(chan struct{})
	go func() { manager.Close(); close(firstDone) }()
	<-blocker.cancelled
	go func() { manager.Close(); close(secondDone) }()
	select {
	case <-secondDone:
		t.Fatal("concurrent Close returned before the active operation stopped")
	case <-time.After(20 * time.Millisecond):
	}
	close(blocker.release)
	for name, done := range map[string]<-chan struct{}{"first": firstDone, "second": secondDone} {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatalf("%s Close did not return", name)
		}
	}
}

func TestCopyRegularFileRejectsSpecialOversizedAndCancelledSources(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target.mmdb")
	symlink := filepath.Join(dir, "symlink.mmdb")
	if err := os.Symlink(writeFixture(t, "country"), symlink); err != nil {
		t.Fatal(err)
	}
	if code := errorCode(copyRegularFile(context.Background(), symlink, target)); code != ErrorSourceNotRegular {
		t.Fatalf("symlink code = %q", code)
	}
	fifo := filepath.Join(dir, "fifo")
	if err := unix.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	if code := errorCode(copyRegularFile(context.Background(), fifo, target)); code != ErrorSourceNotRegular {
		t.Fatalf("fifo code = %q", code)
	}
	oversized := filepath.Join(dir, "oversized.mmdb")
	if err := os.WriteFile(oversized, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(oversized, maxDatabaseBytes+1); err != nil {
		t.Fatal(err)
	}
	if code := errorCode(copyRegularFile(context.Background(), oversized, target)); code != ErrorSourceTooLarge {
		t.Fatalf("oversized code = %q", code)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if code := errorCode(copyRegularFile(ctx, writeFixture(t, "country"), target)); code != ErrorSourceUnavailable {
		t.Fatalf("cancelled copy code = %q", code)
	}
}

func TestRefreshDueRespectsScheduleAndDoesNotRetryImmediately(t *testing.T) {
	manager := NewManager(t.TempDir(), newMemorySettings())
	defer manager.Close()
	now := time.Unix(2_000_000_000, 0)
	manager.now = func() time.Time { return now }
	manager.mu.Lock()
	manager.config = Config{
		Enabled: true, Source: SourceURLs, Schedule: ScheduleDaily,
		Country: DatabaseConfig{Enabled: true, Location: "https://example.test/country.mmdb"},
	}
	manager.status = errorStatus(nil, ErrorDownloadFailed)
	manager.lastAttempt = now
	manager.mu.Unlock()
	if manager.refreshDue() {
		t.Fatal("failed operation retried immediately")
	}
	now = now.Add(25 * time.Hour)
	if !manager.refreshDue() {
		t.Fatal("daily operation was not due")
	}
	manager.mu.Lock()
	manager.config.Source = SourceFiles
	manager.mu.Unlock()
	if manager.refreshDue() {
		t.Fatal("local files scheduled an automatic reread")
	}
}

func TestManagerDisableAndMissingDataDir(t *testing.T) {
	settingsStore := newMemorySettings()
	manager := NewManager(t.TempDir(), settingsStore)
	cfg := fileConfig(writeFixture(t, "country"), "", "")
	if _, err := manager.PutConfig(cfg); err != nil {
		t.Fatal(err)
	}
	waitState(t, manager, StateReady)
	cfg.Enabled = false
	settings, err := manager.PutConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if settings.Status.State != StateDisabled || settings.Status.Available || settings.Status.ActiveSource != nil || len(settings.Status.Databases) != 0 || settings.Status.LastError != nil {
		t.Fatalf("disabled = %+v", settings.Status)
	}
	if manager.Lookup("81.2.69.142") != nil {
		t.Fatal("disabled manager returned geography")
	}
	manager.Close()

	noDataDir := NewManager("", newMemorySettings())
	defer noDataDir.Close()
	if _, err := noDataDir.PutConfig(fileConfig(writeFixture(t, "country"), "", "")); err != nil {
		t.Fatal(err)
	}
	status := waitState(t, noDataDir, StateError)
	if status.LastError == nil || *status.LastError != ErrorDataDirRequired {
		t.Fatalf("missing data_dir status = %+v", status)
	}
}

func TestLookupPageIsConsistentAndCacheIsBounded(t *testing.T) {
	manager := NewManager(t.TempDir(), newMemorySettings())
	defer manager.Close()
	if _, err := manager.PutConfig(fileConfig(writeFixture(t, "country"), "", "")); err != nil {
		t.Fatal(err)
	}
	waitState(t, manager, StateReady)

	status, results := manager.LookupPage([]string{"81.2.69.142", "10.0.0.1", "203.0.113.254", "invalid"})
	if status.State != StateReady || len(results) != 4 || results[0] == nil || results[0].State != ResultFound ||
		results[1] == nil || results[1].State != ResultPrivate || results[2] == nil || results[2].State != ResultNotFound || results[3] != nil {
		t.Fatalf("page status=%+v results=%+v", status, results)
	}
	for i := 0; i < cacheCapacity+300; i++ {
		manager.Lookup(fmt.Sprintf("11.0.%d.%d", (i/256)%256, i%256))
	}
	manager.cacheMu.Lock()
	cacheLen := len(manager.cache)
	manager.cacheMu.Unlock()
	if cacheLen > cacheCapacity {
		t.Fatalf("cache grew to %d", cacheLen)
	}
}

func TestManagerRejectsBusyAndSurvivesConcurrentLookupUpdateClose(t *testing.T) {
	busyManager := NewManager(t.TempDir(), newMemorySettings())
	blocker := &blockingDownloader{started: make(chan struct{}), cancelled: make(chan struct{}), release: make(chan struct{})}
	busyManager.client = blocker
	busyConfig := Config{
		Enabled: true, Source: SourceURLs, Schedule: ScheduleManual,
		Country: DatabaseConfig{Enabled: true, Location: "https://example.test/country.mmdb"},
	}
	if _, err := busyManager.PutConfig(busyConfig); err != nil {
		t.Fatal(err)
	}
	<-blocker.started
	if _, err := busyManager.Update(); !errors.Is(err, ErrBusy) {
		t.Fatalf("concurrent update error = %v", err)
	}
	busyDone := make(chan struct{})
	go func() { busyManager.Close(); close(busyDone) }()
	<-blocker.cancelled
	close(blocker.release)
	<-busyDone

	manager := NewManager(t.TempDir(), newMemorySettings())
	cfg := fileConfig(writeFixture(t, "country"), writeFixture(t, "asn"), "")
	if _, err := manager.PutConfig(cfg); err != nil {
		t.Fatal(err)
	}
	waitState(t, manager, StateReady)

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 500; j++ {
				manager.Lookup("81.2.69.142")
				manager.Lookup("1.0.0.1")
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 10; i++ {
			if _, err := manager.Update(); err == nil {
				for manager.Status().State == StateUpdating {
					time.Sleep(time.Millisecond)
				}
			}
		}
	}()
	wg.Wait()
	manager.Close()
	manager.Close()
	if manager.Lookup("81.2.69.142") != nil {
		t.Fatal("closed manager returned geography")
	}
}

func TestManagerDoesNotPersistInvalidConfig(t *testing.T) {
	settingsStore := newMemorySettings()
	manager := NewManager(t.TempDir(), settingsStore)
	defer manager.Close()
	invalid := DefaultConfig()
	invalid.Source = "invalid"
	if _, err := manager.PutConfig(invalid); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("invalid config error = %v", err)
	}
	if _, ok, _ := settingsStore.GetSetting(configSettingKey); ok {
		t.Fatal("invalid config persisted")
	}
	settingsStore.setErr = errors.New("write failed")
	if _, err := manager.PutConfig(DefaultConfig()); err == nil {
		t.Fatal("store failure ignored")
	}
}
