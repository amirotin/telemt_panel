package update

import (
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// Probe holds the filesystem and command checks libc variant detection
// relies on, injectable so tests can supply fixture values instead of
// touching the real host.
type Probe struct {
	// Stat reports whether path exists.
	Stat func(path string) bool
	// LddVersion returns the output of `ldd --version` (or an error if the
	// command isn't available).
	LddVersion func() (string, error)
}

// DefaultProbe checks the real filesystem and shells out to ldd.
func DefaultProbe() Probe {
	return Probe{
		Stat: func(path string) bool {
			_, err := os.Stat(path)
			return err == nil
		},
		LddVersion: func() (string, error) {
			out, err := exec.Command("ldd", "--version").CombinedOutput()
			return string(out), err
		},
	}
}

// DetectLibc determines whether the host should use "musl" or "gnu" release
// binaries. This is router-critical operational knowledge: OpenWrt and
// Alpine are the primary musl deployment targets and often lack a usable
// `ldd`, so the filesystem markers are checked first. Detection order:
//  1. /etc/alpine-release or /etc/openwrt_release exists → musl
//  2. `ldd --version` output contains "musl" → musl
//  3. otherwise → gnu
func DetectLibc(p Probe) string {
	if p.Stat("/etc/alpine-release") || p.Stat("/etc/openwrt_release") {
		return "musl"
	}
	if out, err := p.LddVersion(); err == nil && strings.Contains(out, "musl") {
		return "musl"
	}
	return "gnu"
}

// DetectArch maps runtime.GOARCH to the architecture token used in release
// asset names.
func DetectArch() string {
	return archToken(runtime.GOARCH)
}

// archToken is the pure, testable core of DetectArch.
func archToken(goarch string) string {
	switch goarch {
	case "amd64":
		return "x86_64"
	case "arm64":
		return "aarch64"
	case "arm":
		return "armv7"
	case "mipsle":
		return "mipsle"
	case "mips":
		return "mips"
	default:
		return goarch
	}
}
