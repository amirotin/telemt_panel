package host

import (
	"context"
	"reflect"
	"testing"
)

func TestSysvinit_Restart_Argv(t *testing.T) {
	r := &fakeRunner{}
	s := NewSysvinit(r.run)

	if err := s.Restart(context.Background(), "telemt"); err != nil {
		t.Fatalf("Restart: %v", err)
	}
	want := []recordedCmd{{name: "/etc/init.d/telemt", args: []string{"restart"}}}
	if !reflect.DeepEqual(r.calls, want) {
		t.Errorf("calls = %#v, want %#v", r.calls, want)
	}
}

// Status never shells out: sysvinit status support is too inconsistent to
// trust, so this package reports it as an outright unsupported capability
// instead of guessing from unreliable output.
func TestSysvinit_Status_AlwaysUnknownNoExec(t *testing.T) {
	r := &fakeRunner{}
	s := NewSysvinit(r.run)

	got, err := s.Status(context.Background(), "telemt")
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if got != StatusUnknown {
		t.Errorf("status = %q, want %q", got, StatusUnknown)
	}
	if len(r.calls) != 0 {
		t.Errorf("calls = %#v, want none", r.calls)
	}
}

func TestSysvinit_Caps(t *testing.T) {
	caps := NewSysvinit(nil).Caps()
	if !caps.CanRestart {
		t.Error("CanRestart = false, want true")
	}
	if caps.CanStatus {
		t.Error("CanStatus = true, want false")
	}
}

func TestSysvinit_Kind(t *testing.T) {
	if got := NewSysvinit(nil).Kind(); got != KindSysvinit {
		t.Errorf("Kind() = %q, want %q", got, KindSysvinit)
	}
}
