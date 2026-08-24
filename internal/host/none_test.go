package host

import (
	"context"
	"errors"
	"testing"
)

func TestNone_Restart_ReturnsManualRestartRequired(t *testing.T) {
	n := NewNone()
	err := n.Restart(context.Background(), "telemt")
	if !errors.Is(err, ErrManualRestartRequired) {
		t.Errorf("err = %v, want ErrManualRestartRequired", err)
	}
}

func TestNone_Status_AlwaysUnknown(t *testing.T) {
	n := NewNone()
	got, err := n.Status(context.Background(), "telemt")
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if got != StatusUnknown {
		t.Errorf("status = %q, want %q", got, StatusUnknown)
	}
}

func TestNone_Caps(t *testing.T) {
	caps := NewNone().Caps()
	if caps.CanRestart || caps.CanStatus {
		t.Errorf("caps = %+v, want both false", caps)
	}
	if caps.ManualRestartHint == "" {
		t.Error("ManualRestartHint is empty, want a hint")
	}
}

func TestNone_Kind(t *testing.T) {
	if got := NewNone().Kind(); got != KindNone {
		t.Errorf("Kind() = %q, want %q", got, KindNone)
	}
}
