package host

import (
	"context"
	"errors"
	"io"
	"reflect"
	"testing"
	"time"
)

func TestParseJournaldLine(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		wantOK  bool
		wantMsg string
		wantLvl string
		wantTS  time.Time
		wantU   string
	}{
		{
			name:    "normal info entry",
			raw:     `{"__REALTIME_TIMESTAMP":"1690000000000000","PRIORITY":"6","MESSAGE":"hello world","_SYSTEMD_UNIT":"telemt.service"}`,
			wantOK:  true,
			wantMsg: "hello world",
			wantLvl: "info",
			wantTS:  time.UnixMicro(1690000000000000),
			wantU:   "telemt.service",
		},
		{name: "priority 0 emerg is error", raw: `{"PRIORITY":"0","MESSAGE":"m"}`, wantOK: true, wantMsg: "m", wantLvl: "error"},
		{name: "priority 3 err is error", raw: `{"PRIORITY":"3","MESSAGE":"m"}`, wantOK: true, wantMsg: "m", wantLvl: "error"},
		{name: "priority 4 warning is warn", raw: `{"PRIORITY":"4","MESSAGE":"m"}`, wantOK: true, wantMsg: "m", wantLvl: "warn"},
		{name: "priority 5 notice is info", raw: `{"PRIORITY":"5","MESSAGE":"m"}`, wantOK: true, wantMsg: "m", wantLvl: "info"},
		{name: "priority 7 debug is debug", raw: `{"PRIORITY":"7","MESSAGE":"m"}`, wantOK: true, wantMsg: "m", wantLvl: "debug"},
		{name: "priority missing is unknown", raw: `{"MESSAGE":"m"}`, wantOK: true, wantMsg: "m", wantLvl: "unknown"},
		{name: "priority null is unknown", raw: `{"PRIORITY":null,"MESSAGE":"m"}`, wantOK: true, wantMsg: "m", wantLvl: "unknown"},
		{name: "priority empty string is unknown", raw: `{"PRIORITY":"","MESSAGE":"m"}`, wantOK: true, wantMsg: "m", wantLvl: "unknown"},
		{name: "priority out of range high is unknown", raw: `{"PRIORITY":"8","MESSAGE":"m"}`, wantOK: true, wantMsg: "m", wantLvl: "unknown"},
		{name: "priority negative is unknown", raw: `{"PRIORITY":"-1","MESSAGE":"m"}`, wantOK: true, wantMsg: "m", wantLvl: "unknown"},
		{name: "priority non-numeric is unknown", raw: `{"PRIORITY":"critical","MESSAGE":"m"}`, wantOK: true, wantMsg: "m", wantLvl: "unknown"},
		{name: "priority as bare JSON number", raw: `{"PRIORITY":3,"MESSAGE":"m"}`, wantOK: true, wantMsg: "m", wantLvl: "error"},
		{name: "message missing", raw: `{"PRIORITY":"6"}`, wantOK: true, wantMsg: "", wantLvl: "info"},
		{
			name:    "message as non-UTF8 byte array",
			raw:     `{"PRIORITY":"6","MESSAGE":[104,105]}`,
			wantOK:  true,
			wantMsg: "hi",
			wantLvl: "info",
		},
		{name: "unparseable timestamp leaves TS zero", raw: `{"__REALTIME_TIMESTAMP":"not-a-number","PRIORITY":"6","MESSAGE":"m"}`, wantOK: true, wantMsg: "m", wantLvl: "info"},
		{name: "malformed json is dropped", raw: `not json at all`, wantOK: false},
		{name: "empty line is dropped", raw: "", wantOK: false},
		{name: "journalctl plain-text notice is dropped", raw: "-- No entries --", wantOK: false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := parseJournaldLine([]byte(tc.raw))
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if !ok {
				return
			}
			if got.Msg != tc.wantMsg {
				t.Errorf("Msg = %q, want %q", got.Msg, tc.wantMsg)
			}
			if got.Level != tc.wantLvl {
				t.Errorf("Level = %q, want %q", got.Level, tc.wantLvl)
			}
			if !tc.wantTS.IsZero() && !got.TS.Equal(tc.wantTS) {
				t.Errorf("TS = %v, want %v", got.TS, tc.wantTS)
			}
			if tc.wantU != "" && got.Unit != tc.wantU {
				t.Errorf("Unit = %q, want %q", got.Unit, tc.wantU)
			}
		})
	}
}

func TestJournald_Tail_Argv(t *testing.T) {
	r := &fakeRunner{stdout: []byte(`{"PRIORITY":"6","MESSAGE":"a"}` + "\n" + `{"PRIORITY":"3","MESSAGE":"b"}` + "\n")}
	j := NewJournald(r.run, nil)

	got, err := j.Tail(context.Background(), "telemt", 50)
	if err != nil {
		t.Fatalf("Tail: %v", err)
	}
	if len(got) != 2 || got[0].Msg != "a" || got[1].Msg != "b" {
		t.Fatalf("got = %+v", got)
	}
	want := []recordedCmd{{name: "journalctl", args: []string{"-u", "telemt", "-n", "50", "--no-pager", "-o", "json"}}}
	if !reflect.DeepEqual(r.calls, want) {
		t.Errorf("calls = %#v, want %#v", r.calls, want)
	}
}

func TestJournald_Tail_Error(t *testing.T) {
	r := &fakeRunner{stderr: []byte("Unit telemt.service not found."), err: &ExitError{Code: 1}}
	j := NewJournald(r.run, nil)

	if _, err := j.Tail(context.Background(), "telemt", 50); err == nil {
		t.Fatal("expected error")
	}
}

func TestJournald_Stream(t *testing.T) {
	pr, pw := io.Pipe()
	starter := &fakeProcessStarter{reader: pr}
	j := NewJournald(nil, starter.start)

	ctx, cancel := context.WithCancel(context.Background())
	ch, err := j.Stream(ctx, "telemt")
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}

	go func() {
		io.WriteString(pw, `{"PRIORITY":"6","MESSAGE":"first"}`+"\n")
	}()
	first := <-ch
	if first.Msg != "first" || first.Level != "info" {
		t.Fatalf("first = %+v", first)
	}

	cancel()
	pw.Close()
	for range ch {
	}

	want := []recordedCmd{{name: "journalctl", args: []string{"-u", "telemt", "-f", "-o", "json"}}}
	if !reflect.DeepEqual(starter.calls, want) {
		t.Errorf("calls = %#v, want %#v", starter.calls, want)
	}
}

func TestJournald_Stream_Error(t *testing.T) {
	starter := &fakeProcessStarter{err: errors.New("boom")}
	j := NewJournald(nil, starter.start)

	if _, err := j.Stream(context.Background(), "telemt"); err == nil {
		t.Fatal("expected error")
	}
}

func TestJournald_Caps(t *testing.T) {
	caps := NewJournald(nil, nil).Caps()
	if !caps.CanTail || !caps.CanStream {
		t.Errorf("caps = %+v, want both true", caps)
	}
}

func TestJournald_Kind(t *testing.T) {
	if got := NewJournald(nil, nil).Kind(); got != LogKindJournald {
		t.Errorf("Kind() = %q, want %q", got, LogKindJournald)
	}
}
