package host

import (
	"strings"
	"time"
)

// ansicWidth is the fixed width of an ANSIC-formatted timestamp ("Mon Jan
// _2 15:04:05 2006", e.g. "Thu Jan  1 00:00:10 1970") — the leading
// timestamp field both logread and a BusyBox-syslogd-written syslog file
// share (OpenWrt's logread just reads the same daemon's output the syslog
// file gets, so the two shapes are near-identical). Slicing by this fixed
// width rather than splitting on spaces avoids the classic ctime pitfall
// where a single-digit day's extra padding space would otherwise look like
// an empty field.
const ansicWidth = len("Mon Jan _2 15:04:05 2006")

// parseSyslogishLine parses one BusyBox-syslogd-style line — shared by
// Logread and Syslog, since both read from the same kind of daemon output:
//
//	Thu Jan  1 00:00:10 1970 daemon.info telemt[123]: message text
//
// The facility.severity token is optional (plain syslog files often omit
// it even though logread's own output usually carries it), so the header
// between the timestamp and "tag[pid]: " is parsed as a variable number of
// whitespace-separated fields: the last field is always the tag, and
// whichever earlier field (if any) contains a '.' is read as
// facility.severity for the level. Any line that doesn't fit this shape at
// all (too short, no "tag: " separator) — or whose timestamp doesn't
// parse — falls back leniently: Level "unknown", the whole original line
// as Msg, rather than being dropped or partially guessed. logread's exact
// output varies across OpenWrt/BusyBox versions, so a mismatch is never
// treated as an error.
func parseSyslogishLine(line string) LogLine {
	if len(line) <= ansicWidth+1 {
		return LogLine{Level: "unknown", Msg: line}
	}
	ts, tsErr := time.Parse(time.ANSIC, line[:ansicWidth])
	rest := strings.TrimPrefix(line[ansicWidth:], " ")

	idx := strings.Index(rest, ": ")
	if idx < 0 {
		return LogLine{Level: "unknown", Msg: line}
	}
	header := rest[:idx]
	msg := rest[idx+2:]

	fields := strings.Fields(header)
	if len(fields) == 0 {
		return LogLine{Level: "unknown", Msg: line}
	}
	unit := stripPID(fields[len(fields)-1])

	level := "unknown"
	for _, f := range fields[:len(fields)-1] {
		if dot := strings.LastIndexByte(f, '.'); dot >= 0 {
			level = severityToLevel(f[dot+1:])
			break
		}
	}

	result := LogLine{Level: level, Unit: unit, Msg: msg}
	if tsErr == nil {
		result.TS = ts
	}
	return result
}

// severityToLevel maps a syslog facility.severity's severity word (the
// part after the last '.') to the panel's normalized level.
func severityToLevel(sev string) string {
	switch strings.ToLower(sev) {
	case "emerg", "alert", "crit", "err", "error":
		return "error"
	case "warn", "warning":
		return "warn"
	case "notice", "info":
		return "info"
	case "debug":
		return "debug"
	default:
		return "unknown"
	}
}

// stripPID removes a trailing "[pid]" from a syslog tag, e.g.
// "telemt[123]" -> "telemt". A tag with no "[" is returned unchanged.
func stripPID(tag string) string {
	if b := strings.IndexByte(tag, '['); b >= 0 {
		return tag[:b]
	}
	return tag
}
