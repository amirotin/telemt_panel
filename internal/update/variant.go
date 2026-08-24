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
// `ldd`, so the filesystem markers are checked first. musl is the safe
// default whenever libc is uncertain — a musl binary runs on both glibc and
// musl hosts, while a gnu binary requires glibc ≥2.32 and fails to start on
// an older router, so "gnu" is returned only on positive evidence.
// Detection order:
//  1. /etc/alpine-release or /etc/openwrt_release exists → musl
//  2. `ldd --version` output contains "musl" → musl
//  3. `ldd --version` output positively indicates glibc (contains "GNU" or
//     "glibc", case-insensitive) → gnu
//  4. anything else — ldd missing, erroring, empty, or unrecognized output
//     → musl (the safe default)
func DetectLibc(p Probe) string {
	if p.Stat("/etc/alpine-release") || p.Stat("/etc/openwrt_release") {
		return "musl"
	}
	out, err := p.LddVersion()
	if err != nil {
		return "musl"
	}
	if strings.Contains(out, "musl") {
		return "musl"
	}
	lower := strings.ToLower(out)
	if strings.Contains(lower, "gnu") || strings.Contains(lower, "glibc") {
		return "gnu"
	}
	return "musl"
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
