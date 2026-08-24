package update

import "testing"

func TestAssetName(t *testing.T) {
	tests := []struct {
		name, arch, variant, want string
	}{
		{"telemt", "x86_64", "gnu", "telemt-x86_64-linux-gnu.tar.gz"},
		{"telemt", "aarch64", "musl", "telemt-aarch64-linux-musl.tar.gz"},
		{"telemt-panel", "x86_64", "gnu", "telemt-panel-x86_64-linux-gnu.tar.gz"},
	}
	for _, tt := range tests {
		if got := AssetName(tt.name, tt.arch, tt.variant); got != tt.want {
			t.Errorf("AssetName(%q,%q,%q) = %q, want %q", tt.name, tt.arch, tt.variant, got, tt.want)
		}
	}
}

func TestNewAssetMatcher(t *testing.T) {
	tests := []struct {
		name      string
		matchName string
		arch      string
		variant   string
		assets    []Asset
		wantBin   string // "" means nil
		wantSum   string // "" means nil
	}{
		{
			name:      "exact variant match wins over other variant",
			matchName: "telemt",
			arch:      "x86_64",
			variant:   "musl",
			assets: []Asset{
				{Name: "telemt-x86_64-linux-gnu.tar.gz"},
				{Name: "telemt-x86_64-linux-gnu.tar.gz.sha256"},
				{Name: "telemt-x86_64-linux-musl.tar.gz"},
				{Name: "telemt-x86_64-linux-musl.tar.gz.sha256"},
			},
			wantBin: "telemt-x86_64-linux-musl.tar.gz",
			wantSum: "telemt-x86_64-linux-musl.tar.gz.sha256",
		},
		{
			name:      "falls back to any published variant for the arch",
			matchName: "telemt-panel",
			arch:      "x86_64",
			variant:   "musl", // detected, but release only ships gnu
			assets: []Asset{
				{Name: "telemt-panel-x86_64-linux-gnu.tar.gz"},
				{Name: "telemt-panel-x86_64-linux-gnu.tar.gz.sha256"},
				{Name: "telemt-panel-aarch64-linux-gnu.tar.gz"}, // different arch, must not match
			},
			wantBin: "telemt-panel-x86_64-linux-gnu.tar.gz",
			wantSum: "telemt-panel-x86_64-linux-gnu.tar.gz.sha256",
		},
		{
			// P3.12: checksum selection is an EXACT "<bin>.sha256" match, not a
			// prefix match — a bare-suffix asset lacking the ".tar.gz" part must
			// not be mistaken for the checksum.
			name:      "bare .sha256 naming (no .tar.gz.sha256 sibling) is not matched",
			matchName: "telemt",
			arch:      "x86_64",
			variant:   "gnu",
			assets: []Asset{
				{Name: "telemt-x86_64-linux-gnu.tar.gz"},
				{Name: "telemt-x86_64-linux-gnu.sha256"},
			},
			wantBin: "telemt-x86_64-linux-gnu.tar.gz",
			wantSum: "",
		},
		{
			// P3.12 regression: an asset whose name merely starts with the
			// binary's name (e.g. a detached signature "<bin>.sha256.asc") must
			// not be picked as the checksum.
			name:      "prefix collision on the checksum name does not match",
			matchName: "telemt",
			arch:      "x86_64",
			variant:   "gnu",
			assets: []Asset{
				{Name: "telemt-x86_64-linux-gnu.tar.gz"},
				{Name: "telemt-x86_64-linux-gnu.tar.gz.sha256.asc"},
			},
			wantBin: "telemt-x86_64-linux-gnu.tar.gz",
			wantSum: "",
		},
		{
			name:      "no checksum published",
			matchName: "telemt",
			arch:      "x86_64",
			variant:   "gnu",
			assets: []Asset{
				{Name: "telemt-x86_64-linux-gnu.tar.gz"},
			},
			wantBin: "telemt-x86_64-linux-gnu.tar.gz",
			wantSum: "",
		},
		{
			name:      "no asset for arch at all",
			matchName: "telemt",
			arch:      "aarch64",
			variant:   "gnu",
			assets: []Asset{
				{Name: "telemt-x86_64-linux-gnu.tar.gz"},
			},
			wantBin: "",
			wantSum: "",
		},
		{
			name:      "name prefix collision does not cross-match panel vs telemt",
			matchName: "telemt",
			arch:      "x86_64",
			variant:   "gnu",
			assets: []Asset{
				{Name: "telemt-panel-x86_64-linux-gnu.tar.gz"},
			},
			wantBin: "",
			wantSum: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			match := NewAssetMatcher(tt.matchName, tt.arch, tt.variant)
			bin, sum := match(tt.assets)

			if tt.wantBin == "" {
				if bin != nil {
					t.Fatalf("binary = %+v, want nil", bin)
				}
			} else {
				if bin == nil || bin.Name != tt.wantBin {
					t.Fatalf("binary = %+v, want name %q", bin, tt.wantBin)
				}
			}

			if tt.wantSum == "" {
				if sum != nil {
					t.Fatalf("checksum = %+v, want nil", sum)
				}
			} else {
				if sum == nil || sum.Name != tt.wantSum {
					t.Fatalf("checksum = %+v, want name %q", sum, tt.wantSum)
				}
			}
		})
	}
}
