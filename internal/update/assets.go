package update

import "strings"

// Asset is a downloadable file attached to a GitHub release.
type Asset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Size               int64  `json:"size"`
}

// AssetMatcher selects the binary and checksum assets for one target from a
// release's asset list. checksum is nil when no matching ".sha256" asset is
// published alongside the chosen binary.
type AssetMatcher func(assets []Asset) (binary *Asset, checksum *Asset)

// AssetName returns the release asset filename for a target/arch/variant
// combination: "<name>-<arch>-linux-<variant>.tar.gz". name is "telemt" for
// the Telemt binary or "telemt-panel" for panel self-update.
func AssetName(name, arch, variant string) string {
	return name + "-" + arch + "-linux-" + variant + ".tar.gz"
}

// NewAssetMatcher returns an AssetMatcher for release assets named
// "<name>-<arch>-linux-<variant>.tar.gz". The detected variant is a
// preference, not a hard requirement: if the exact
// "<name>-<arch>-linux-<variant>.tar.gz" asset is published it wins,
// otherwise the first published asset for the same arch (any variant) is
// used instead — this keeps updates working when libc detection falls back
// to a variant a given release doesn't publish (e.g. musl detected on a
// host but the release only ships a gnu static binary). The checksum asset
// is the one named exactly "<bin>.sha256" — an exact match, not a prefix
// match, so e.g. a "<bin>.sha256.asc" signature asset is never mistaken
// for the checksum.
func NewAssetMatcher(name, arch, variant string) AssetMatcher {
	archPrefix := name + "-" + arch + "-linux-"
	preferred := archPrefix + variant + ".tar.gz"

	return func(assets []Asset) (*Asset, *Asset) {
		var bin *Asset
		for i := range assets {
			n := assets[i].Name
			if !strings.HasPrefix(n, archPrefix) || !strings.HasSuffix(n, ".tar.gz") {
				continue
			}
			if n == preferred {
				bin = &assets[i]
				break // exact variant match wins
			}
			if bin == nil {
				bin = &assets[i] // fall back to first published variant for this arch
			}
		}
		if bin == nil {
			return nil, nil
		}

		sumName := bin.Name + ".sha256"
		var sum *Asset
		for i := range assets {
			if assets[i].Name == sumName {
				sum = &assets[i]
				break
			}
		}
		return bin, sum
	}
}

// NewPanelAssetMatcher preserves the running panel's full/lite profile.
// Canonical post-1.0 assets have no libc suffix because both binaries are
// static; the transitional 1.0 libc names remain a fallback so a 1.0 panel
// can update itself before those compatibility duplicates are retired.
func NewPanelAssetMatcher(arch, libc, buildVariant string) AssetMatcher {
	if arch != "x86_64" && arch != "aarch64" {
		return func([]Asset) (*Asset, *Asset) { return nil, nil }
	}
	name := "telemt-panel"
	if buildVariant == "lite" {
		name += "-lite"
	}
	canonical := name + "-" + arch + "-linux.tar.gz"
	legacy := AssetName(name, arch, libc)
	return func(assets []Asset) (*Asset, *Asset) {
		var bin *Asset
		for i := range assets {
			if assets[i].Name == canonical {
				bin = &assets[i]
				break
			}
			if assets[i].Name == legacy {
				bin = &assets[i]
			}
		}
		if bin == nil {
			return nil, nil
		}
		var checksum *Asset
		for i := range assets {
			if assets[i].Name == bin.Name+".sha256" {
				checksum = &assets[i]
				break
			}
		}
		return bin, checksum
	}
}
