package host

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestSystemd_Restart_Argv(t *testing.T) {
	r := &fakeRunner{}
	s := NewSystemd(r.run)

	if err := s.Restart(context.Background(), "telemt"); err != nil {
		t.Fatalf("Restart: %v", err)
	}
	want := []recordedCmd{{name: "systemctl", args: []string{"restart", "telemt"}}}
	if !reflect.DeepEqual(r.calls, want) {
		t.Errorf("calls = %#v, want %#v", r.calls, want)
	}
}

func TestSystemd_Restart_Error(t *testing.T) {
	r := &fakeRunner{stderr: []byte("Unit telemt.service not found."), err: &ExitError{Code: 5}}
	s := NewSystemd(r.run)

	err := s.Restart(context.Background(), "telemt")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestSystemd_Status(t *testing.T) {
	tests := []struct {
		name    string
		stdout  string
		runErr  error
		want    ServiceStatus
		wantErr bool
	}{
		{name: "active", stdout: "active", want: StatusRunning},
		{name: "inactive", stdout: "inactive\n", runErr: &ExitError{Code: 3}, want: StatusStopped},
		{name: "failed", stdout: "failed\n", runErr: &ExitError{Code: 3}, want: StatusStopped},
		{name: "activating", stdout: "activating\n", want: StatusUnknown},
		{name: "unit unknown", stdout: "unknown\n", runErr: &ExitError{Code: 4}, want: StatusUnknown},
		{name: "empty stdout with error", stdout: "", runErr: errors.New("boom"), want: StatusUnknown, wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := &fakeRunner{stdout: []byte(tc.stdout), err: tc.runErr}
			s := NewSystemd(r.run)

			got, err := s.Status(context.Background(), "telemt")
			if got != tc.want {
				t.Errorf("status = %q, want %q", got, tc.want)
			}
			if (err != nil) != tc.wantErr {
				t.Errorf("err = %v, wantErr %v", err, tc.wantErr)
			}
			wantArgv := []recordedCmd{{name: "systemctl", args: []string{"is-active", "telemt"}}}
			if !reflect.DeepEqual(r.calls, wantArgv) {
				t.Errorf("calls = %#v, want %#v", r.calls, wantArgv)
			}
		})
	}
}

func TestSystemd_Caps(t *testing.T) {
	s := NewSystemd(nil)
	caps := s.Caps()
	if !caps.CanRestart || !caps.CanStatus {
		t.Errorf("caps = %+v, want both true", caps)
	}
	if caps.ManualRestartHint != "" {
		t.Errorf("hint = %q, want empty", caps.ManualRestartHint)
	}
}

func TestSystemd_Kind(t *testing.T) {
	if got := NewSystemd(nil).Kind(); got != KindSystemd {
		t.Errorf("Kind() = %q, want %q", got, KindSystemd)
	}
}
