package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/amirotin/telemt_panel/internal/host"
)

// Sanitized shape of Telemt's real console output carried in journal MESSAGE.
const coloredTelemtWarning = "\x1b[2m2026-09-12T14:00:00.123456Z\x1b[0m \x1b[33m WARN\x1b[0m \x1b[2mtelemt::transport::upstream\x1b[0m\x1b[2m:\x1b[0m Upstream unavailable \x1b[3mattempt\x1b[0m\x1b[2m=\x1b[0m2"
const plainTelemtWarning = "2026-09-12T14:00:00.123456Z  WARN telemt::transport::upstream: Upstream unavailable attempt=2"

func TestStripLogControls(t *testing.T) {
	tests := []struct{ name, input, want string }{
		{"plain", "WARN is part of the message", "WARN is part of the message"},
		{"telemt", coloredTelemtWarning, plainTelemtWarning},
		{"unicode", "\x1b[32mСоединение 日本語 😀\x1b[0m", "Соединение 日本語 😀"},
		{"literal escape", `data=\x1b[32m`, `data=\x1b[32m`},
		{"whitespace", "a\r\n\tb\n", "a\r\n\tb\n"},
		{"controls", "a\x00\a\b\x7fb", "ab"},
		{"cursor", "a\x1b[2K\x1b[1;1Hb", "ab"},
		{"charset", "a\x1b(Bb", "ab"},
		{"osc bell", "a\x1b]0;terminal title\ab", "ab"},
		{"osc hyperlink", "\x1b]8;;https://example.invalid\x1b\\label\x1b]8;;\x1b\\", "label"},
		{"dcs", "a\x1bPprivate\x1b\\b", "ab"},
		{"unicode csi", "a\u009b31mb\u009b0m", "ab"},
		{"unicode osc", "a\u009dtitle\u009cb", "ab"},
		{"unicode ordinary", "café € русский", "café € русский"},
		{"incomplete esc", "text\x1b", "text"},
		{"incomplete csi", "text\x1b[31;", "text"},
		{"invalid csi", "a\x1b[31\nsecond", "a\nsecond"},
		{"incomplete osc", "a\x1b]title\nsecond", "a\nsecond"},
		{"incomplete dcs", "a\x1bPprivate\r\nsecond", "a\r\nsecond"},
		{"nested esc", "a\x1b[\x1b[31mb", "ab"},
		{"invalid utf8 cannot form control", "\xc2\x1b[0m\x9c", "\uFFFD\uFFFD"},
		{"invalid utf8 fuzz regression", "\xc2\x10\x9c", "\uFFFD\uFFFD"},
		{"html stays text", "\x1b[31m<script>alert(1)</script>\x1b[0m", "<script>alert(1)</script>"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := stripLogControls(tt.input); got != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestLogPresentationTelemtPrefix(t *testing.T) {
	ts := time.Unix(1000, 0).UTC()
	tests := []struct{ name, logical, msg, want string }{
		{"console", "telemt", coloredTelemtWarning, "warn"},
		{"uncolored", "telemt", plainTelemtWarning, "warn"},
		{"panel priority", "panel", coloredTelemtWarning, "info"},
		{"other crate", "telemt", "2026-09-12T14:00:00Z ERROR other::module: failed", "info"},
		{"embedded word", "telemt", "request contains WARN and ERROR", "info"},
		{"missing date", "telemt", "WARN telemt::module: failed", "info"},
		{"invalid date", "telemt", "not-a-date WARN telemt::module: failed", "info"},
		{"invalid date range", "telemt", "2026-99-12T14:00:00Z WARN telemt::module: failed", "info"},
		{"payload date", "telemt", "prefix 2026-09-12T14:00:00Z WARN telemt::module: failed", "info"},
		{"invalid target", "telemt", "2026-09-12T14:00:00Z WARN telemt::bad<script>: failed", "info"},
		{"different app", "telemt", "2026-09-12T14:00:00Z WARN telemt-other: failed", "info"},
		{"multiline", "telemt", "context\n2026-09-12T14:00:00Z WARN telemt::module: failed", "info"},
		{"json unchanged", "telemt", `{"level":"ERROR","message":"2026-09-12T14:00:00Z WARN telemt: payload"}`, "info"},
		{"error", "telemt", "2026-09-12T14:00:00Z ERROR telemt: failed", "error"},
		{"debug", "telemt", "2026-09-12T14:00:00Z DEBUG telemt::module: detail", "debug"},
		{"trace", "telemt", "2026-09-12T14:00:00Z TRACE telemt::module: detail", "debug"},
		{"syslog priority", "telemt", "Upstream unavailable", "info"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			input := host.LogLine{TS: ts, Level: "info", Unit: "custom-service", Msg: tt.msg}
			got := toAPILogLine(input, tt.logical)
			if got.Level != tt.want || got.TS != ts || got.Unit != input.Unit || got.Msg != stripLogControls(tt.msg) {
				t.Fatalf("got %+v, want level %s with original timestamp/unit and readable text", got, tt.want)
			}
		})
	}

	got := toAPILogLine(host.LogLine{Msg: coloredTelemtWarning}, "telemt")
	if got.TS.Format(time.RFC3339Nano) != "2026-09-12T14:00:00.123456Z" {
		t.Fatalf("missing file/docker timestamp was not recovered: %+v", got)
	}
}

func TestLogTailAndStreamNormalizeIdentically(t *testing.T) {
	for _, logical := range []string{"telemt", "panel"} {
		t.Run(logical, func(t *testing.T) {
			srv, cookie, _, source := newHostTestServer(t)
			source.CapsValue = host.LogCaps{CanTail: true, CanStream: true}
			input := host.LogLine{TS: time.Unix(1234, 0).UTC(), Level: "info", Unit: "custom-unit", Msg: coloredTelemtWarning}
			source.TailResult = []host.LogLine{input}
			source.StreamFunc = func(context.Context, string) (<-chan host.LogEvent, error) {
				ch := make(chan host.LogEvent, 1)
				ch <- host.LogEvent{LogLine: input}
				close(ch)
				return ch, nil
			}
			request := func(path string) *httptest.ResponseRecorder {
				r := httptest.NewRequest(http.MethodGet, path+"?service="+logical, nil)
				r.AddCookie(cookie)
				w := httptest.NewRecorder()
				srv.Handler().ServeHTTP(w, r)
				if w.Code != http.StatusOK {
					t.Fatalf("%s: status %d: %s", path, w.Code, w.Body)
				}
				return w
			}
			var tail []apiLogLine
			if err := json.Unmarshal(request("/api/logs/tail").Body.Bytes(), &tail); err != nil {
				t.Fatal(err)
			}
			body := request("/api/events/logs").Body.String()
			frame := strings.SplitN(body, "\n\n", 2)[0]
			data := strings.TrimSpace(strings.TrimPrefix(frame, "event: log\ndata: "))
			var streamed apiLogLine
			if err := json.Unmarshal([]byte(data), &streamed); err != nil {
				t.Fatalf("stream frame %q: %v", body, err)
			}
			wantLevel := "warn"
			if logical == "panel" {
				wantLevel = "info"
			}
			if len(tail) != 1 || tail[0] != streamed || streamed.Msg != plainTelemtWarning || streamed.Level != wantLevel {
				t.Fatalf("tail=%+v stream=%+v", tail, streamed)
			}
			if source.TailResult[0] != input {
				t.Fatal("normalization modified the source record")
			}
		})
	}
}

func TestJournaldMessagePresentation(t *testing.T) {
	for _, byteArray := range []bool{false, true} {
		var message any = coloredTelemtWarning
		if byteArray {
			values := make([]int, len(coloredTelemtWarning))
			for i, b := range []byte(coloredTelemtWarning) {
				values[i] = int(b)
			}
			message = values
		}
		raw, err := json.Marshal(map[string]any{
			"__REALTIME_TIMESTAMP": "1000000000",
			"_SYSTEMD_UNIT":        "custom-telemt.service",
			"PRIORITY":             "6", "MESSAGE": message,
		})
		if err != nil {
			t.Fatal(err)
		}
		source := host.NewJournald(func(context.Context, string, ...string) ([]byte, []byte, error) {
			return raw, nil, nil
		}, nil)
		lines, err := source.Tail(context.Background(), "custom-telemt", 1)
		if err != nil || len(lines) != 1 {
			t.Fatalf("journald: %v %v", lines, err)
		}
		got := toAPILogLine(lines[0], "telemt")
		if got.Level != "warn" || got.Msg != plainTelemtWarning || got.Unit != "custom-telemt.service" || !got.TS.Equal(time.Unix(1000, 0)) {
			t.Fatalf("byte array=%v: %+v", byteArray, got)
		}
	}
}

func FuzzStripLogControls(f *testing.F) {
	for _, s := range []string{coloredTelemtWarning, "plain", "a\x1b]hidden\nnext", "\u009b31m日本語", "\x1b[\x1b", "\xc2\x1b[0m\x9c"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, msg string) {
		got := stripLogControls(msg)
		if len(got) > len(msg)*3 || strings.IndexFunc(got, logControl) >= 0 {
			t.Fatalf("invalid normalized output: %q", got)
		}
		if !utf8.ValidString(got) {
			t.Fatal("damaged UTF-8")
		}
		var out bytes.Buffer
		if err := writeLogSSEEvent(&out, host.LogLine{Msg: msg}, "telemt"); err != nil {
			t.Fatal(err)
		}
		if strings.Count(out.String(), "\ndata: ") != 1 {
			t.Fatal("message escaped its SSE frame")
		}
	})
}

func BenchmarkLogPresentation(b *testing.B) {
	for _, tc := range []struct{ name, msg string }{
		{"plain", plainTelemtWarning},
		{"colored", coloredTelemtWarning},
		{"long", strings.Repeat("\x1b[31mДанные\x1b[0m ", 32000)},
	} {
		b.Run(tc.name, func(b *testing.B) {
			b.ReportAllocs()
			b.SetBytes(int64(len(tc.msg)))
			for b.Loop() {
				toAPILogLine(host.LogLine{Msg: tc.msg}, "telemt")
			}
		})
	}
}
