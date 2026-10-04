package geography

import (
	"context"
	"testing"
	"time"
)

type heldSettings struct {
	SettingsStore
	started, release chan struct{}
}

func (st *heldSettings) SetSetting(key, value string) error {
	close(st.started)
	<-st.release
	return st.SettingsStore.SetSetting(key, value)
}

func TestServiceSettingsReadDoesNotWaitForPersist(t *testing.T) {
	_, _, _, _, memory := serviceFixture(t)
	st := &heldSettings{SettingsStore: memory, started: make(chan struct{}), release: make(chan struct{})}
	s := NewService(Dependencies{State: st})
	defer s.Close()
	done := make(chan error, 1)
	go func() {
		_, err := s.PutSettings(context.Background(), ServerLocationConfig{Mode: "manual", Latitude: ptr(0.0), Longitude: ptr(0.0)})
		done <- err
	}()
	<-st.started
	result := make(chan Settings, 1)
	go func() { settings, _ := s.Settings(context.Background()); result <- settings }()
	select {
	case settings := <-result:
		close(st.release)
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		if settings.ServerLocation.Mode != "hidden" {
			t.Fatal("unpersisted position was published")
		}
	case <-time.After(150 * time.Millisecond):
		close(st.release)
		<-done
		<-result
		t.Fatal("settings read blocked behind persistence")
	}
}
