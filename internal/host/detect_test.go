package host

import (
	"testing"
	"time"
)

// fixtureProbe builds a Probe over an in-memory marker set — no real
// filesystem or PATH access.
func fixtureProbe(paths map[string]bool, pathBins map[string]bool) Probe {
	return Probe{
		Stat:     func(path string) bool { return paths[path] },
		LookPath: func(name string) bool { return pathBins[name] },
	}
}

func TestDetectServiceManagerKind(t *testing.T) {
	tests := []struct {
		name       string
		configured string
		paths      map[string]bool
		pathBins   map[string]bool
		want       string
	}{
		{
			name:       "systemd marker",
			configured: "auto",
			paths:      map[string]bool{"/run/systemd/system": true},
			want:       KindSystemd,
		},
		{
			name:       "openrc marker via /run/openrc",
			configured: "auto",
			paths:      map[string]bool{"/run/openrc": true},
			want:       KindOpenRC,
		},
		{
			name:       "openrc marker via PATH",
			configured: "auto",
			pathBins:   map[string]bool{"rc-service": true},
			want:       KindOpenRC,
		},
		{
			name:       "procd marker (OpenWrt)",
			configured: "auto",
			paths:      map[string]bool{"/etc/openwrt_release": true},
			want:       KindProcd,
		},
		{
			name:       "sysvinit marker",
			configured: "auto",
			paths:      map[string]bool{"/etc/init.d": true},
			want:       KindSysvinit,
		},
		{
			name:       "no markers falls back to none",
			configured: "auto",
			want:       KindNone,
		},
		{
			name:       "systemd wins over openrc and sysvinit when both present",
			configured: "auto",
			paths: map[string]bool{
				"/run/systemd/system": true,
				"/run/openrc":         true,
				"/etc/init.d":         true,
			},
			want: KindSystemd,
		},
		{
			name:       "openrc wins over procd and sysvinit when both present",
			configured: "auto",
			paths: map[string]bool{
				"/run/openrc":          true,
				"/etc/openwrt_release": true,
				"/etc/init.d":          true,
			},
			want: KindOpenRC,
		},
		{
			name:       "procd wins over sysvinit when both present",
			configured: "auto",
			paths: map[string]bool{
				"/etc/openwrt_release": true,
				"/etc/init.d":          true,
			},
			want: KindProcd,
		},
		{
			name:       "empty configured treated as auto",
			configured: "",
			paths:      map[string]bool{"/etc/openwrt_release": true},
			want:       KindProcd,
		},
		{
			name:       "config override wins over markers",
			configured: "docker",
			paths:      map[string]bool{"/run/systemd/system": true},
			want:       KindDocker,
		},
		{
			name:       "config override to none wins over markers",
			configured: "none",
			paths:      map[string]bool{"/run/systemd/system": true},
			want:       KindNone,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := fixtureProbe(tc.paths, tc.pathBins)
			if got := DetectServiceManagerKind(tc.configured, p); got != tc.want {
				t.Errorf("DetectServiceManagerKind(%q) = %q, want %q", tc.configured, got, tc.want)
			}
		})
	}
}

func TestDetectLogSourceKind(t *testing.T) {
	tests := []struct {
		name       string
		configured string
		svcKind    string
		paths      map[string]bool
		want       string
	}{
		{name: "config override wins", configured: "docker", svcKind: KindSystemd, want: LogKindDocker},
		{name: "config override to none wins", configured: "none", svcKind: KindSystemd, want: LogKindNone},
		{name: "empty configured treated as auto", configured: "", svcKind: KindSystemd, want: LogKindJournald},
		{name: "journald follows systemd", configured: "auto", svcKind: KindSystemd, want: LogKindJournald},
		{name: "logread follows procd", configured: "auto", svcKind: KindProcd, want: LogKindLogread},
		{
			name:       "docker wins over a syslog marker when both present",
			configured: "auto",
			svcKind:    KindDocker,
			paths:      map[string]bool{"/var/log/messages": true},
			want:       LogKindDocker,
		},
		{
			name:       "syslog via /var/log/syslog",
			configured: "auto",
			svcKind:    KindOpenRC,
			paths:      map[string]bool{"/var/log/syslog": true},
			want:       LogKindSyslog,
		},
		{name: "docker follows docker service manager", configured: "auto", svcKind: KindDocker, want: LogKindDocker},
		{name: "no markers and no matching service manager falls back to none", configured: "auto", svcKind: KindSysvinit, want: LogKindNone},
		{name: "systemd wins over a syslog marker", configured: "auto", svcKind: KindSystemd, paths: map[string]bool{"/var/log/syslog": true}, want: LogKindJournald},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := fixtureProbe(tc.paths, nil)
			if got := DetectLogSourceKind(tc.configured, tc.svcKind, p); got != tc.want {
				t.Errorf("DetectLogSourceKind(%q, %q) = %q, want %q", tc.configured, tc.svcKind, got, tc.want)
			}
		})
	}
}

func TestNewLogSource_ReturnsMatchingKind(t *testing.T) {
	tests := []struct {
		name       string
		configured string
		logFile    string
		svcKind    string
		paths      map[string]bool
		wantKind   string
	}{
		{name: "journald", configured: "journald", svcKind: KindSystemd, wantKind: LogKindJournald},
		{name: "logread", configured: "logread", svcKind: KindProcd, wantKind: LogKindLogread},
		{
			name:       "syslog with a detected marker",
			configured: "syslog",
			paths:      map[string]bool{"/var/log/syslog": true},
			wantKind:   LogKindSyslog,
		},
		{
			name:       "syslog with no marker degrades to none",
			configured: "syslog",
			wantKind:   LogKindNone,
		},
		{name: "docker", configured: "docker", wantKind: LogKindDocker},
		{name: "file with a configured path", configured: "file", logFile: "/var/log/telemt.log", wantKind: LogKindFile},
		{name: "file with no configured path degrades to none", configured: "file", logFile: "", wantKind: LogKindNone},
		{name: "auto with nothing detected falls back to none", configured: "auto", wantKind: LogKindNone},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := fixtureProbe(tc.paths, nil)
			ls := NewLogSource(tc.configured, tc.logFile, tc.svcKind, p, nil, nil, time.Second)
			if got := ls.Kind(); got != tc.wantKind {
				t.Errorf("Kind() = %q, want %q", got, tc.wantKind)
			}
		})
	}
}

func TestNewServiceManager_ReturnsMatchingKind(t *testing.T) {
	tests := []struct {
		configured string
		wantKind   string
	}{
		{configured: "systemd", wantKind: KindSystemd},
		{configured: "openrc", wantKind: KindOpenRC},
		{configured: "procd", wantKind: KindProcd},
		{configured: "sysvinit", wantKind: KindSysvinit},
		{configured: "docker", wantKind: KindDocker},
		{configured: "none", wantKind: KindNone},
	}
	for _, tc := range tests {
		t.Run(tc.configured, func(t *testing.T) {
			m := NewServiceManager(tc.configured, fixtureProbe(nil, nil), nil)
			if got := m.Kind(); got != tc.wantKind {
				t.Errorf("Kind() = %q, want %q", got, tc.wantKind)
			}
		})
	}
}
