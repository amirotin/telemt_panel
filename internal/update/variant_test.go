package update

import (
	"errors"
	"runtime"
	"testing"
)

func fixtureProbe(paths map[string]bool, lddOut string, lddErr error) Probe {
	return Probe{
		Stat: func(path string) bool { return paths[path] },
		LddVersion: func() (string, error) {
			return lddOut, lddErr
		},
	}
}

func TestDetectLibc(t *testing.T) {
	tests := []struct {
		name   string
		paths  map[string]bool
		lddOut string
		lddErr error
		want   string
	}{
		{
			name:  "alpine marker wins over gnu ldd",
			paths: map[string]bool{"/etc/alpine-release": true},
			want:  "musl",
		},
		{
			name:  "openwrt marker wins over gnu ldd",
			paths: map[string]bool{"/etc/openwrt_release": true},
			want:  "musl",
		},
		{
			name:   "ldd reports musl",
			paths:  map[string]bool{},
			lddOut: "ldd (musl libc) 1.2.3",
			want:   "musl",
		},
		{
			name:   "glibc ldd (GLIBC token), no markers",
			paths:  map[string]bool{},
			lddOut: "ldd (Ubuntu GLIBC 2.35-0ubuntu3.8) 2.35",
			want:   "gnu",
		},
		{
			name:   "glibc ldd (GNU libc token), no markers",
			paths:  map[string]bool{},
			lddOut: "ldd (GNU libc) 2.35",
			want:   "gnu",
		},
		{
			name:   "ldd missing entirely defaults to safe musl, not gnu",
			paths:  map[string]bool{},
			lddErr: errors.New("exec: \"ldd\": executable file not found in $PATH"),
			want:   "musl",
		},
		{
			name:   "unrecognized ldd output defaults to safe musl, not gnu",
			paths:  map[string]bool{},
			lddOut: "some unexpected banner text",
			want:   "musl",
		},
		{
			name:   "empty ldd output defaults to safe musl, not gnu",
			paths:  map[string]bool{},
			lddOut: "",
			want:   "musl",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := fixtureProbe(tt.paths, tt.lddOut, tt.lddErr)
			if got := DetectLibc(p); got != tt.want {
				t.Errorf("DetectLibc() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestArchToken(t *testing.T) {
	tests := []struct {
		goarch string
		want   string
	}{
		{"amd64", "x86_64"},
		{"arm64", "aarch64"},
		{"arm", "armv7"},
		{"mipsle", "mipsle"},
		{"mips", "mips"},
		{"riscv64", "riscv64"}, // unknown arch passes through verbatim
	}
	for _, tt := range tests {
		t.Run(tt.goarch, func(t *testing.T) {
			if got := archToken(tt.goarch); got != tt.want {
				t.Errorf("archToken(%q) = %q, want %q", tt.goarch, got, tt.want)
			}
		})
	}
}

func TestDetectArch_MatchesRuntimeGOARCH(t *testing.T) {
	// DetectArch has no injectable input (spec: derived straight from
	// runtime.GOARCH); confirm it delegates to the tested pure mapping.
	if got, want := DetectArch(), archToken(runtime.GOARCH); got != want {
		t.Errorf("DetectArch() = %q, want %q", got, want)
	}
}
