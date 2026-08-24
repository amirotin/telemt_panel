package host

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestDocker_Restart_Argv(t *testing.T) {
	r := &fakeRunner{}
	d := NewDocker(r.run)

	if err := d.Restart(context.Background(), "telemt"); err != nil {
		t.Fatalf("Restart: %v", err)
	}
	want := []recordedCmd{{name: "docker", args: []string{"restart", "telemt"}}}
	if !reflect.DeepEqual(r.calls, want) {
		t.Errorf("calls = %#v, want %#v", r.calls, want)
	}
}

func TestDocker_Status(t *testing.T) {
	tests := []struct {
		name    string
		stdout  string
		runErr  error
		want    ServiceStatus
		wantErr bool
	}{
		{name: "running", stdout: "running\n", want: StatusRunning},
		{name: "exited", stdout: "exited\n", want: StatusStopped},
		{name: "dead", stdout: "dead\n", want: StatusStopped},
		{name: "paused", stdout: "paused\n", want: StatusStopped},
		{name: "unrecognized", stdout: "removing\n", want: StatusUnknown},
		{name: "no such container", stdout: "", runErr: errors.New("no such object"), want: StatusUnknown, wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := &fakeRunner{stdout: []byte(tc.stdout), err: tc.runErr}
			d := NewDocker(r.run)

			got, err := d.Status(context.Background(), "telemt")
			if got != tc.want {
				t.Errorf("status = %q, want %q", got, tc.want)
			}
			if (err != nil) != tc.wantErr {
				t.Errorf("err = %v, wantErr %v", err, tc.wantErr)
			}
			wantArgv := []recordedCmd{{name: "docker", args: []string{"inspect", "-f", "{{.State.Status}}", "telemt"}}}
			if !reflect.DeepEqual(r.calls, wantArgv) {
				t.Errorf("calls = %#v, want %#v", r.calls, wantArgv)
			}
		})
	}
}

func TestDocker_Caps(t *testing.T) {
	caps := NewDocker(nil).Caps()
	if !caps.CanRestart || !caps.CanStatus {
		t.Errorf("caps = %+v, want both true", caps)
	}
}

func TestDocker_Kind(t *testing.T) {
	if got := NewDocker(nil).Kind(); got != KindDocker {
		t.Errorf("Kind() = %q, want %q", got, KindDocker)
	}
}
