package host

import (
	"context"
	"errors"
	"io"
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
		{name: "restarting", stdout: "restarting\n", want: StatusUnknown},
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

func TestDockerLog_Tail_Argv_MergesStdoutAndStderr(t *testing.T) {
	r := &fakeRunner{stdout: []byte("out1\nout2\n"), stderr: []byte("err1\n")}
	d := NewDockerLog(r.run, nil)

	got, err := d.Tail(context.Background(), "telemt", 100)
	if err != nil {
		t.Fatalf("Tail: %v", err)
	}
	if len(got) != 3 || got[0].Msg != "out1" || got[1].Msg != "out2" || got[2].Msg != "err1" {
		t.Fatalf("got = %+v, want [out1 out2 err1]", got)
	}
	for _, l := range got {
		if l.Unit != "telemt" {
			t.Errorf("Unit = %q, want telemt", l.Unit)
		}
		if l.Level != "unknown" {
			t.Errorf("Level = %q, want unknown", l.Level)
		}
	}
	want := []recordedCmd{{name: "docker", args: []string{"logs", "--tail", "100", "telemt"}}}
	if !reflect.DeepEqual(r.calls, want) {
		t.Errorf("calls = %#v, want %#v", r.calls, want)
	}
}

func TestDockerLog_Tail_Error(t *testing.T) {
	r := &fakeRunner{stderr: []byte("no such container"), err: errors.New("boom")}
	d := NewDockerLog(r.run, nil)

	if _, err := d.Tail(context.Background(), "telemt", 100); err == nil {
		t.Fatal("expected error")
	}
}

func TestDockerLog_Stream(t *testing.T) {
	pr, pw := io.Pipe()
	starter := &fakeProcessStarter{reader: pr}
	d := NewDockerLog(nil, starter.start)

	ctx, cancel := context.WithCancel(context.Background())
	ch, err := d.Stream(ctx, "telemt")
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}

	go func() { io.WriteString(pw, "line one\n") }()
	first := <-ch
	if first.Msg != "line one" || first.Unit != "telemt" {
		t.Fatalf("first = %+v", first)
	}

	cancel()
	pw.Close()
	for range ch {
	}

	want := []recordedCmd{{name: "docker", args: []string{"logs", "-f", "telemt"}}}
	if !reflect.DeepEqual(starter.calls, want) {
		t.Errorf("calls = %#v, want %#v", starter.calls, want)
	}
}

func TestDockerLog_Stream_Error(t *testing.T) {
	starter := &fakeProcessStarter{err: errors.New("boom")}
	d := NewDockerLog(nil, starter.start)

	if _, err := d.Stream(context.Background(), "telemt"); err == nil {
		t.Fatal("expected error")
	}
}

func TestDockerLog_Caps(t *testing.T) {
	caps := NewDockerLog(nil, nil).Caps()
	if !caps.CanTail || !caps.CanStream {
		t.Errorf("caps = %+v, want both true", caps)
	}
}

func TestDockerLog_Kind(t *testing.T) {
	if got := NewDockerLog(nil, nil).Kind(); got != LogKindDocker {
		t.Errorf("Kind() = %q, want %q", got, LogKindDocker)
	}
}
