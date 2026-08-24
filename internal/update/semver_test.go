package update

import "testing"

func TestParseVersion(t *testing.T) {
	tests := []struct {
		input               string
		major, minor, patch int
		pre                 string
		wantErr             bool
	}{
		{"v1.2.3", 1, 2, 3, "", false},
		{"1.2.3", 1, 2, 3, "", false},
		{"v3.3.10", 3, 3, 10, "", false},
		{"3.3.10", 3, 3, 10, "", false},
		{"v1.0.0-rc1", 1, 0, 0, "rc1", false},
		{"v2.1.0-beta.2", 2, 1, 0, "beta.2", false},
		{"v1.2.3+build.5", 1, 2, 3, "", false},
		{"v1.2.3-rc1+build.5", 1, 2, 3, "rc1", false},
		{"", 0, 0, 0, "", true},
		{"invalid", 0, 0, 0, "", true},
		{"v1.2", 0, 0, 0, "", true},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			maj, min, pat, pre, err := ParseVersion(tt.input)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ParseVersion(%q) error = %v, wantErr %v", tt.input, err, tt.wantErr)
			}
			if err != nil {
				return
			}
			if maj != tt.major || min != tt.minor || pat != tt.patch || pre != tt.pre {
				t.Errorf("ParseVersion(%q) = (%d,%d,%d,%q), want (%d,%d,%d,%q)",
					tt.input, maj, min, pat, pre, tt.major, tt.minor, tt.patch, tt.pre)
			}
		})
	}
}

// TestCompareVersions ports the v0 internal/github/semver_test.go cases as a
// behavioral baseline.
func TestCompareVersions(t *testing.T) {
	tests := []struct {
		a, b string
		want int
	}{
		{"v1.0.0", "v1.0.0", 0},
		{"v1.0.1", "v1.0.0", 1},
		{"v1.0.0", "v1.0.1", -1},
		{"v2.0.0", "v1.9.9", 1},
		{"v1.2.0", "v1.1.9", 1},
		{"3.3.10", "v3.3.9", 1},         // bare vs prefixed
		{"v1.0.0", "v1.0.0-rc1", 1},     // release > pre-release
		{"v1.0.0-rc1", "v1.0.0", -1},    // pre-release < release
		{"v1.0.0-rc2", "v1.0.0-rc1", 1}, // pre-release lexicographic
	}
	for _, tt := range tests {
		t.Run(tt.a+"_vs_"+tt.b, func(t *testing.T) {
			got := CompareVersions(tt.a, tt.b)
			if got != tt.want {
				t.Errorf("CompareVersions(%q, %q) = %d, want %d", tt.a, tt.b, got, tt.want)
			}
		})
	}
}

// TestCompareVersions_SemverPrecedenceChain reproduces the semver.org §11
// example precedence chain, exercising numeric-vs-alphanumeric identifier
// comparison and identifier-count tiebreaks that the v0 lexicographic
// comparator did not need to get right.
func TestCompareVersions_SemverPrecedenceChain(t *testing.T) {
	chain := []string{
		"1.0.0-alpha",
		"1.0.0-alpha.1",
		"1.0.0-alpha.beta",
		"1.0.0-beta",
		"1.0.0-beta.2",
		"1.0.0-beta.11",
		"1.0.0-rc.1",
		"1.0.0",
	}
	for i := 0; i < len(chain)-1; i++ {
		a, b := chain[i], chain[i+1]
		if got := CompareVersions(a, b); got != -1 {
			t.Errorf("CompareVersions(%q, %q) = %d, want -1", a, b, got)
		}
		if got := CompareVersions(b, a); got != 1 {
			t.Errorf("CompareVersions(%q, %q) = %d, want 1", b, a, got)
		}
	}
}

func TestCompareVersions_Unparseable(t *testing.T) {
	if got := CompareVersions("garbage", "garbage2"); got != 0 {
		t.Errorf("both unparseable: got %d, want 0", got)
	}
	if got := CompareVersions("garbage", "v1.0.0"); got != -1 {
		t.Errorf("a unparseable: got %d, want -1", got)
	}
	if got := CompareVersions("v1.0.0", "garbage"); got != 1 {
		t.Errorf("b unparseable: got %d, want 1", got)
	}
}
