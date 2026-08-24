package host

import (
	"testing"
	"time"
)

// TestParseSyslogishLine covers parseSyslogishLine, shared by Logread and
// Syslog (see syslogline.go's doc comment for why the two formats are
// close enough to share one parser). Assertions are exact-match, not
// substring, on every field — this parser is what stands between raw log
// text and the frontend (host.go's documented invariant: the frontend
// never parses raw log text), so a subtly wrong Level/Unit/Msg split must
// fail the test, not just "contains the right words somewhere".
func TestParseSyslogishLine(t *testing.T) {
	tests := []struct {
		name string
		line string
		want LogLine
	}{
		{
			name: "well-formed daemon.info line with facility.severity",
			line: "Thu Jan  1 00:00:10 1970 daemon.info telemt[123]: user alice connected",
			want: LogLine{TS: mustParseANSIC(t, "Thu Jan  1 00:00:10 1970"), Level: "info", Unit: "telemt", Msg: "user alice connected"},
		},
		{
			name: "daemon.err maps to error",
			line: "Thu Jan  1 00:00:10 1970 daemon.err telemt[123]: boom",
			want: LogLine{TS: mustParseANSIC(t, "Thu Jan  1 00:00:10 1970"), Level: "error", Unit: "telemt", Msg: "boom"},
		},
		{
			name: "user.warning maps to warn, no pid suffix",
			line: "Thu Jan  1 00:00:10 1970 user.warning telemt: low memory",
			want: LogLine{TS: mustParseANSIC(t, "Thu Jan  1 00:00:10 1970"), Level: "warn", Unit: "telemt", Msg: "low memory"},
		},
		{
			name: "unrecognized severity word maps to unknown but tag/msg still parse",
			line: "Thu Jan  1 00:00:10 1970 daemon.strange telemt: message",
			want: LogLine{TS: mustParseANSIC(t, "Thu Jan  1 00:00:10 1970"), Level: "unknown", Unit: "telemt", Msg: "message"},
		},
		{
			// The variant Finding 1 calls out explicitly: a plain syslog
			// file line with no facility.severity token at all (common —
			// logread's own output usually carries one, but a syslogd
			// writing straight to a file often doesn't). Level must stay
			// "unknown" rather than misreading the tag as a severity
			// field, while Unit/Msg still parse correctly.
			name: "no severity token — tag and message still parse, level unknown",
			line: "Thu Jan  1 00:00:10 1970 telemt[42]: no facility.severity token here",
			want: LogLine{TS: mustParseANSIC(t, "Thu Jan  1 00:00:10 1970"), Level: "unknown", Unit: "telemt", Msg: "no facility.severity token here"},
		},
		{
			name: "hostname token ahead of tag, no real severity, still unknown",
			line: "Thu Jan  1 00:00:10 1970 myhost telemt[1]: message",
			want: LogLine{TS: mustParseANSIC(t, "Thu Jan  1 00:00:10 1970"), Level: "unknown", Unit: "telemt", Msg: "message"},
		},
		{
			name: "too short to contain a timestamp",
			line: "garbage",
			want: LogLine{Level: "unknown", Msg: "garbage"},
		},
		{
			name: "line is exactly the timestamp width, no header at all",
			line: "Thu Jan  1 00:00:10 1970 ",
			want: LogLine{Level: "unknown", Msg: "Thu Jan  1 00:00:10 1970 "},
		},
		{
			// idx := strings.Index(rest, ": ") finds nothing, so this is a
			// total fallback: the whole original line as Msg, TS left
			// zero even though the timestamp region itself would have
			// parsed — the line as a whole didn't match the expected
			// shape, so nothing about it is trusted piecemeal.
			name: "no colon separator anywhere falls back to the whole raw line",
			line: "Thu Jan  1 00:00:10 1970 daemon.info this has no colon separator",
			want: LogLine{Level: "unknown", Msg: "Thu Jan  1 00:00:10 1970 daemon.info this has no colon separator"},
		},
		{
			name: "unparseable timestamp still parses the rest, TS stays zero",
			line: "XXX XXX XX XX:XX:XX XXXX daemon.info telemt: message",
			want: LogLine{Level: "info", Unit: "telemt", Msg: "message"},
		},
		{
			name: "empty line",
			line: "",
			want: LogLine{Level: "unknown", Msg: ""},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := parseSyslogishLine(tc.line)
			if got != tc.want {
				t.Errorf("parseSyslogishLine(%q) =\n  %+v\nwant\n  %+v", tc.line, got, tc.want)
			}
		})
	}
}

// mustParseANSIC parses s as an ANSIC timestamp for building `want` fixtures.
func mustParseANSIC(t *testing.T, s string) time.Time {
	t.Helper()
	ts, err := time.Parse(time.ANSIC, s)
	if err != nil {
		t.Fatalf("mustParseANSIC(%q): %v", s, err)
	}
	return ts
}
