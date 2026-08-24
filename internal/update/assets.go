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
// is whichever ".sha256"-suffixed asset shares the chosen binary's name
// prefix, covering both "<bin>.sha256" and "<bin>.tar.gz.sha256" naming.
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

		sumPrefix := strings.TrimSuffix(bin.Name, ".tar.gz")
		var sum *Asset
		for i := range assets {
			n := assets[i].Name
			if strings.HasPrefix(n, sumPrefix) && strings.HasSuffix(n, ".sha256") {
				sum = &assets[i]
				break
			}
		}
		return bin, sum
	}
}
