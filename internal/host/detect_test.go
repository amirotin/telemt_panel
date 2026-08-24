package host

import "testing"

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
