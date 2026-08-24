package host

import (
	"context"
	"reflect"
	"testing"
)

func TestOpenRC_Restart_Argv(t *testing.T) {
	r := &fakeRunner{}
	o := NewOpenRC(r.run)

	if err := o.Restart(context.Background(), "telemt"); err != nil {
		t.Fatalf("Restart: %v", err)
	}
	want := []recordedCmd{{name: "rc-service", args: []string{"telemt", "restart"}}}
	if !reflect.DeepEqual(r.calls, want) {
		t.Errorf("calls = %#v, want %#v", r.calls, want)
	}
}

func TestOpenRC_Status(t *testing.T) {
	tests := []struct {
		name   string
		stdout string
		want   ServiceStatus
	}{
		{name: "started", stdout: " * status:  started\n", want: StatusRunning},
		{name: "stopped", stdout: " * status:  stopped\n", want: StatusStopped},
		{name: "crashed", stdout: " * status:  crashed\n", want: StatusStopped},
		{name: "unrecognized", stdout: " * status:  paused\n", want: StatusUnknown},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := &fakeRunner{stdout: []byte(tc.stdout)}
			o := NewOpenRC(r.run)

			got, err := o.Status(context.Background(), "telemt")
			if err != nil {
				t.Fatalf("Status: %v", err)
			}
			if got != tc.want {
				t.Errorf("status = %q, want %q", got, tc.want)
			}
			wantArgv := []recordedCmd{{name: "rc-service", args: []string{"telemt", "status"}}}
			if !reflect.DeepEqual(r.calls, wantArgv) {
				t.Errorf("calls = %#v, want %#v", r.calls, wantArgv)
			}
		})
	}
}

func TestOpenRC_Caps(t *testing.T) {
	caps := NewOpenRC(nil).Caps()
	if !caps.CanRestart || !caps.CanStatus {
		t.Errorf("caps = %+v, want both true", caps)
	}
}

func TestOpenRC_Kind(t *testing.T) {
	if got := NewOpenRC(nil).Kind(); got != KindOpenRC {
		t.Errorf("Kind() = %q, want %q", got, KindOpenRC)
	}
}
