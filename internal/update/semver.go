// Package update implements the release-lookup half of the host update
// engine: listing GitHub releases, semver comparison, libc/arch variant
// detection, and asset matching. See v2/specs/03-update-engine.md.
package update

import (
	"fmt"
	"strconv"
	"strings"
)

// ParseVersion parses a version string of the form "v?MAJOR.MINOR.PATCH[-prerelease]"
// (optional build metadata after a "+" is accepted and discarded, per
// semver.org §10 — it never affects precedence). Returns major, minor,
// patch, and the pre-release suffix (empty for a release version).
func ParseVersion(s string) (major, minor, patch int, pre string, err error) {
	if s == "" {
		return 0, 0, 0, "", fmt.Errorf("empty version string")
	}
	s = strings.TrimPrefix(s, "v")

	if idx := strings.IndexByte(s, '+'); idx >= 0 {
		s = s[:idx]
	}
	if idx := strings.IndexByte(s, '-'); idx >= 0 {
		pre = s[idx+1:]
		s = s[:idx]
	}

	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return 0, 0, 0, "", fmt.Errorf("invalid version format: %q", s)
	}

	major, err = strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, 0, "", fmt.Errorf("invalid major version: %w", err)
	}
	minor, err = strconv.Atoi(parts[1])
	if err != nil {
		return 0, 0, 0, "", fmt.Errorf("invalid minor version: %w", err)
	}
	patch, err = strconv.Atoi(parts[2])
	if err != nil {
		return 0, 0, 0, "", fmt.Errorf("invalid patch version: %w", err)
	}

	return major, minor, patch, pre, nil
}

// CompareVersions compares two version strings following semver.org §11
// precedence rules. Returns -1 if a < b, 0 if a == b, 1 if a > b. An
// unparseable version sorts after a parseable one; two unparseable versions
// compare equal — this keeps release lists stable rather than erroring when
// GitHub carries a tag that doesn't look like a version.
func CompareVersions(a, b string) int {
	aMaj, aMin, aPat, aPre, aErr := ParseVersion(a)
	bMaj, bMin, bPat, bPre, bErr := ParseVersion(b)

	if aErr != nil && bErr != nil {
		return 0
	}
	if aErr != nil {
		return -1
	}
	if bErr != nil {
		return 1
	}

	if aMaj != bMaj {
		return cmpInt(aMaj, bMaj)
	}
	if aMin != bMin {
		return cmpInt(aMin, bMin)
	}
	if aPat != bPat {
		return cmpInt(aPat, bPat)
	}
	return comparePrerelease(aPre, bPre)
}

func cmpInt(a, b int) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	default:
		return 0
	}
}

// comparePrerelease implements semver.org §11 rule 4: a version without a
// pre-release has higher precedence than one with the same major.minor.patch;
// otherwise dot-separated identifiers are compared left to right — numeric
// identifiers compare numerically and always have lower precedence than
// alphanumeric ones at the same position, alphanumeric identifiers compare
// in ASCII order, and a shorter identifier list that is a prefix of a longer
// one has lower precedence.
func comparePrerelease(a, b string) int {
	if a == "" && b == "" {
		return 0
	}
	if a == "" {
		return 1
	}
	if b == "" {
		return -1
	}

	aIDs := strings.Split(a, ".")
	bIDs := strings.Split(b, ".")

	for i := 0; i < len(aIDs) && i < len(bIDs); i++ {
		if c := compareIdentifier(aIDs[i], bIDs[i]); c != 0 {
			return c
		}
	}
	return cmpInt(len(aIDs), len(bIDs))
}

// compareIdentifier compares one dot-separated pre-release identifier pair.
func compareIdentifier(a, b string) int {
	aNum, aIsNum := numericIdentifier(a)
	bNum, bIsNum := numericIdentifier(b)

	switch {
	case aIsNum && bIsNum:
		return cmpInt(aNum, bNum)
	case aIsNum && !bIsNum:
		return -1
	case !aIsNum && bIsNum:
		return 1
	default:
		switch {
		case a < b:
			return -1
		case a > b:
			return 1
		default:
			return 0
		}
	}
}

// numericIdentifier reports whether s is composed entirely of ASCII digits
// and, if so, its value.
func numericIdentifier(s string) (int, bool) {
	if s == "" {
		return 0, false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, false
		}
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0, false
	}
	return n, true
}
