package github

import "time"

// GitHubRelease represents a release from the GitHub API.
type GitHubRelease struct {
	TagName     string        `json:"tag_name"`
	Name        string        `json:"name"`
	Body        string        `json:"body"`
	HTMLURL     string        `json:"html_url"`
	PublishedAt time.Time     `json:"published_at"`
	Prerelease  bool          `json:"prerelease"`
	Draft       bool          `json:"draft"`
	Assets      []GitHubAsset `json:"assets"`
}

// GitHubAsset represents a downloadable asset attached to a release.
type GitHubAsset struct {
	Name               string `json:"name"`
	Size               int64  `json:"size"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

// AssetMatcher finds the binary and checksum assets from a release's asset list.
type AssetMatcher func(assets []GitHubAsset) (binary *GitHubAsset, checksum *GitHubAsset)

// ReleaseInfo is the API response representation of a single release.
type ReleaseInfo struct {
	Version     string `json:"version"`
	Name        string `json:"name"`
	Changelog   string `json:"changelog"`
	PublishedAt string `json:"published_at"`
	HTMLURL     string `json:"html_url"`
	Prerelease  bool   `json:"prerelease"`
	IsDowngrade bool   `json:"is_downgrade"`
	AssetURL    string `json:"asset_url"`
	AssetSize   int64  `json:"asset_size"`
	ChecksumURL string `json:"checksum_url"`
}

// ReleasesResult is returned by the /releases endpoint.
type ReleasesResult struct {
	CurrentVersion string        `json:"current_version"`
	Releases       []ReleaseInfo `json:"releases"`
}
