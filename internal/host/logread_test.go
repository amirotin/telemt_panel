package host

import (
	"context"
	"errors"
	"io"
	"reflect"
	"testing"
)

func TestParseLogreadLine(t *testing.T) {
	tests := []struct {
		name    string
		line    string
		wantLvl string
		wantU   string
		wantMsg string
		wantTS  bool // whether TS should be non-zero
	}{
		{
			name:    "well-formed daemon.info line",
			line:    "Thu Jan  1 00:00:10 1970 daemon.info telemt[123]: user alice connected",
			wantLvl: "info",
			wantU:   "telemt",
			wantMsg: "user alice connected",
			wantTS:  true,
		},
		{
			name:    "daemon.err maps to error",
			line:    "Thu Jan  1 00:00:10 1970 daemon.err telemt[123]: boom",
			wantLvl: "error",
			wantU:   "telemt",
			wantMsg: "boom",
			wantTS:  true,
		},
		{
			name:    "user.warning maps to warn",
			line:    "Thu Jan  1 00:00:10 1970 user.warning telemt: low memory",
			wantLvl: "warn",
			wantU:   "telemt",
			wantMsg: "low memory",
			wantTS:  true,
		},
		{
			name:    "no pid suffix",
			line:    "Thu Jan  1 00:00:10 1970 daemon.debug telemt: verbose message",
			wantLvl: "debug",
			wantU:   "telemt",
			wantMsg: "verbose message",
			wantTS:  true,
		},
		{
			name:    "unrecognized severity word",
			line:    "Thu Jan  1 00:00:10 1970 daemon.strange telemt: message",
			wantLvl: "unknown",
			wantU:   "telemt",
			wantMsg: "message",
			wantTS:  true,
		},
		{
			name:    "too short to contain a timestamp",
			line:    "garbage",
			wantLvl: "unknown",
			wantMsg: "garbage",
		},
		{
			name:    "no facility.severity field after timestamp",
			line:    "Thu Jan  1 00:00:10 1970 ",
			wantLvl: "unknown",
			wantMsg: "Thu Jan  1 00:00:10 1970 ",
		},
		{
			name:    "no tag separator falls back to whole tail as msg",
			line:    "Thu Jan  1 00:00:10 1970 daemon.info this has no colon separator",
			wantLvl: "info",
			wantMsg: "this has no colon separator",
			wantTS:  true,
		},
		{
			name:    "unparseable timestamp still parses the rest",
			line:    "XXX XXX XX XX:XX:XX XXXX daemon.info telemt: message",
			wantLvl: "info",
			wantU:   "telemt",
			wantMsg: "message",
			wantTS:  false,
		},
		{
			name:    "empty line",
			line:    "",
			wantLvl: "unknown",
			wantMsg: "",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := parseLogreadLine(tc.line)
			if got.Level != tc.wantLvl {
				t.Errorf("Level = %q, want %q", got.Level, tc.wantLvl)
			}
			if got.Msg != tc.wantMsg {
				t.Errorf("Msg = %q, want %q", got.Msg, tc.wantMsg)
			}
			if tc.wantU != "" && got.Unit != tc.wantU {
				t.Errorf("Unit = %q, want %q", got.Unit, tc.wantU)
			}
			if tc.wantTS && got.TS.IsZero() {
				t.Error("TS is zero, want non-zero")
			}
			if !tc.wantTS && !got.TS.IsZero() {
				t.Errorf("TS = %v, want zero", got.TS)
			}
		})
	}
}

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
