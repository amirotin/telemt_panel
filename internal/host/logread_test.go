package host

import (
	"context"
	"errors"
	"io"
	"reflect"
	"testing"
)

// Line parsing itself is covered by TestParseSyslogishLine in
// syslogline_test.go — parseSyslogishLine is shared between Logread and
// Syslog (see syslogline.go).

func TestLogread_Tail_Argv(t *testing.T) {
	out := "Thu Jan  1 00:00:10 1970 daemon.info telemt[1]: a\n" +
		"Thu Jan  1 00:00:11 1970 daemon.info telemt[1]: b\n" +
		"Thu Jan  1 00:00:12 1970 daemon.info telemt[1]: c\n"
	r := &fakeRunner{stdout: []byte(out)}
	l := NewLogread(r.run, nil)

	got, err := l.Tail(context.Background(), "telemt", 2)
	if err != nil {
		t.Fatalf("Tail: %v", err)
	}
	if len(got) != 2 || got[0].Msg != "b" || got[1].Msg != "c" {
		t.Fatalf("got = %+v, want the last 2 of [a b c]", got)
	}
	want := []recordedCmd{{name: "logread", args: []string{"-e", "telemt"}}}
	if !reflect.DeepEqual(r.calls, want) {
		t.Errorf("calls = %#v, want %#v", r.calls, want)
	}
}

func TestLogread_Tail_Error(t *testing.T) {
	r := &fakeRunner{err: errors.New("not found")}
	l := NewLogread(r.run, nil)

	if _, err := l.Tail(context.Background(), "telemt", 50); err == nil {
		t.Fatal("expected error")
	}
}

func TestLogread_Stream(t *testing.T) {
	pr, pw := io.Pipe()
	starter := &fakeProcessStarter{reader: pr}
	l := NewLogread(nil, starter.start)

	ctx, cancel := context.WithCancel(context.Background())
	ch, err := l.Stream(ctx, "telemt")
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}

	go func() {
		io.WriteString(pw, "Thu Jan  1 00:00:10 1970 daemon.info telemt[1]: hello\n")
	}()
	first := <-ch
	if first.Msg != "hello" || first.Level != "info" {
		t.Fatalf("first = %+v", first)
	}

	cancel()
	pw.Close()
	for range ch {
	}

	want := []recordedCmd{{name: "logread", args: []string{"-f"}}}
	if !reflect.DeepEqual(starter.calls, want) {
		t.Errorf("calls = %#v, want %#v", starter.calls, want)
	}
}

func TestLogread_Caps(t *testing.T) {
	caps := NewLogread(nil, nil).Caps()
	if !caps.CanTail || !caps.CanStream {
		t.Errorf("caps = %+v, want both true", caps)
	}
}

func TestLogread_Kind(t *testing.T) {
	if got := NewLogread(nil, nil).Kind(); got != LogKindLogread {
		t.Errorf("Kind() = %q, want %q", got, LogKindLogread)
	}
}
