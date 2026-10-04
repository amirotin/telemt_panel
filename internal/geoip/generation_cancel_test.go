package geoip

import (
	"context"
	"errors"
	"testing"
	"time"
)

type heldConfigStore struct {
	SettingsStore
	started, release chan struct{}
}

func (s *heldConfigStore) SetSetting(k, v string) error {
	close(s.started)
	<-s.release
	return s.SettingsStore.SetSetting(k, v)
}

func TestLookupBatchGenerationDoesNotWaitForConfigPersist(t *testing.T) {
	settings := &heldConfigStore{SettingsStore: newMemorySettings(), started: make(chan struct{}), release: make(chan struct{})}
	m := NewManager(t.TempDir(), settings)
	defer m.Close()
	previous := m.Generation()
	done := make(chan error, 1)
	go func() { _, err := m.PutConfig(DefaultConfig()); done <- err }()
	<-settings.started
	result := make(chan uint64, 1)
	go func() { result <- m.Generation() }()
	select {
	case gen := <-result:
		if gen != previous {
			t.Fatal("unpersisted generation published")
		}
	case <-time.After(150 * time.Millisecond):
		close(settings.release)
		<-done
		<-result
		t.Fatal("generation read blocked behind persistence")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := m.LookupBatch(ctx, []string{"1.1.1.1"}, previous); !errors.Is(err, context.Canceled) {
		close(settings.release)
		<-done
		t.Fatalf("batch cancel=%v", err)
	}
	close(settings.release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
