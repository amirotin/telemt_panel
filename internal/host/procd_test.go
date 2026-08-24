package host

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestProcd_Restart_Argv(t *testing.T) {
	r := &fakeRunner{}
	p := NewProcd(r.run)

	if err := p.Restart(context.Background(), "telemt"); err != nil {
		t.Fatalf("Restart: %v", err)
	}
	want := []recordedCmd{{name: "/etc/init.d/telemt", args: []string{"restart"}}}
	if !reflect.DeepEqual(r.calls, want) {
		t.Errorf("calls = %#v, want %#v", r.calls, want)
	}
}

func TestProcd_Status_ExitCodes(t *testing.T) {
	tests := []struct {
		name    string
		err     error
		want    ServiceStatus
		wantErr bool
	}{
		{name: "running (exit 0)", err: nil, want: StatusRunning},
		{name: "stopped (exit 1)", err: &ExitError{Code: 1}, want: StatusStopped},
		{name: "stopped (exit 3)", err: &ExitError{Code: 3}, want: StatusStopped},
		{name: "script missing", err: errors.New("exec: no such file"), want: StatusUnknown, wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := &fakeRunner{err: tc.err}
			p := NewProcd(r.run)

			got, err := p.Status(context.Background(), "telemt")
			if got != tc.want {
				t.Errorf("status = %q, want %q", got, tc.want)
			}
			if (err != nil) != tc.wantErr {
				t.Errorf("err = %v, wantErr %v", err, tc.wantErr)
			}
			wantArgv := []recordedCmd{{name: "/etc/init.d/telemt", args: []string{"running"}}}
			if !reflect.DeepEqual(r.calls, wantArgv) {
				t.Errorf("calls = %#v, want %#v", r.calls, wantArgv)
			}
		})
	}
}

func TestProcd_Caps(t *testing.T) {
	caps := NewProcd(nil).Caps()
	if !caps.CanRestart || !caps.CanStatus {
		t.Errorf("caps = %+v, want both true", caps)
	}
}

func TestProcd_Kind(t *testing.T) {
	if got := NewProcd(nil).Kind(); got != KindProcd {
		t.Errorf("Kind() = %q, want %q", got, KindProcd)
	}
}
