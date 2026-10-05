package quotareset

import (
	"context"
	"errors"
	"testing"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

func TestScheduledReservationExcludesManualUntilJobAssignment(t *testing.T) {
	f := fixture(1)
	resetStarted, finishReset := make(chan struct{}), make(chan struct{})
	f.reset = func(context.Context, string, string) (telemt.QuotaEntry, error) {
		close(resetStarted)
		<-finishReset
		return telemt.QuotaEntry{}, nil
	}
	m := New(f, nil)
	defer m.Close()
	entered, finishReserve := make(chan struct{}), make(chan struct{})
	scheduledDone := make(chan error, 1)
	go func() {
		_, err := m.ExecuteScheduled(context.Background(), func(names []string, _ string) ([]string, error) { close(entered); <-finishReserve; return names, nil })
		scheduledDone <- err
	}()
	<-entered
	manualDone := make(chan error, 1)
	go func() { _, err := m.Prepare(context.Background()); manualDone <- err }()
	close(finishReserve)
	<-resetStarted
	if err := <-manualDone; !errors.Is(err, ErrBusy) {
		t.Errorf("manual admission during claimed scheduled reset=%v", err)
	}
	close(finishReset)
	if err := <-scheduledDone; err != nil {
		t.Fatal(err)
	}
}

func TestScheduledFailedReservationReleasesAdmission(t *testing.T) {
	m := New(fixture(1), nil)
	defer m.Close()
	want := errors.New("durable claim failed")
	if _, err := m.ExecuteScheduled(context.Background(), func([]string, string) ([]string, error) { return nil, want }); !errors.Is(err, want) {
		t.Fatal(err)
	}
	if _, err := m.Prepare(context.Background()); err != nil {
		t.Fatalf("failed reservation blocked later manual reset=%v", err)
	}
}
