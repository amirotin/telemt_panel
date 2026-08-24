package update

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// maxDownloadSize bounds a single downloaded release asset — generous for
// a native binary tarball, small enough to stop a malicious or
// misconfigured browser_download_url from filling the staging disk.
const maxDownloadSize = 512 << 20

// maxExtractedBinarySize bounds the one binary extracted from a release
// tarball, for the same reason.
const maxExtractedBinarySize = 512 << 20

// download fetches url into dest, bound to ctx. Any non-200 response is an
// error — a release asset URL redirecting to a 404 or GitHub rate-limit
// page must not be silently accepted as a valid tarball.
func (e *Engine) download(ctx context.Context, url, dest string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("update: build download request for %q: %w", url, err)
	}
	resp, err := e.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("update: download %q: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("update: download %q: http %d", url, resp.StatusCode)
	}

	out, err := os.Create(dest)
	if err != nil {
		return fmt.Errorf("update: create %q: %w", dest, err)
	}
	_, copyErr := io.Copy(out, io.LimitReader(resp.Body, maxDownloadSize))
	closeErr := out.Close()
	if copyErr != nil {
		return fmt.Errorf("update: write %q: %w", dest, copyErr)
	}
	if closeErr != nil {
		return fmt.Errorf("update: close %q: %w", dest, closeErr)
	}
	return nil
}

// sha256File returns path's content hex-encoded SHA-256 sum.
func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("update: open %q: %w", path, err)
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", fmt.Errorf("update: hash %q: %w", path, err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// parseChecksumFile extracts the hex digest from a ".sha256" asset's
// content, tolerating both the bare-hash form and the coreutils
// "<hash>  <filename>" form; returns "" for empty/unparseable content.
func parseChecksumFile(content string) string {
	fields := strings.Fields(content)
	if len(fields) == 0 {
		return ""
	}
	return strings.ToLower(fields[0])
}

// findRelease returns the release tagged exactly version.
func findRelease(releases []Release, version string) (Release, bool) {
	for _, r := range releases {
		if r.Tag == version {
			return r, true
		}
	}
	return Release{}, false
}

// extractSingleBinary extracts tarGzPath's one expected regular-file entry
// into destDir/"bin" and returns its path. Directory entries are skipped;
// an entry whose name is absolute or contains a ".." segment is rejected
// outright (path traversal — CVE-class tar extraction bug); anything other
// than exactly one regular file among the remaining entries is an error, a
// release asset tarball is expected to contain just the binary.
func extractSingleBinary(tarGzPath, destDir string) (string, error) {
	f, err := os.Open(tarGzPath)
	if err != nil {
		return "", fmt.Errorf("update: open %q: %w", tarGzPath, err)
	}
	defer f.Close()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return "", fmt.Errorf("update: gzip %q: %w", tarGzPath, err)
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	destPath := filepath.Join(destDir, "bin")
	found := false

	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", fmt.Errorf("update: read tar %q: %w", tarGzPath, err)
		}
		if strings.HasPrefix(hdr.Name, "/") || strings.Contains(hdr.Name, "..") {
			return "", fmt.Errorf("update: tar entry %q escapes the archive", hdr.Name)
		}
		if hdr.Typeflag == tar.TypeDir {
			continue
		}
		if hdr.Typeflag != tar.TypeReg {
			continue // symlinks and other special entries are never the binary
		}
		if found {
			return "", fmt.Errorf("update: tar %q contains more than one regular file", tarGzPath)
		}
		found = true

		out, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
		if err != nil {
			return "", fmt.Errorf("update: create %q: %w", destPath, err)
		}
		_, copyErr := io.Copy(out, io.LimitReader(tr, maxExtractedBinarySize))
		closeErr := out.Close()
		if copyErr != nil {
			return "", fmt.Errorf("update: write %q: %w", destPath, copyErr)
		}
		if closeErr != nil {
			return "", fmt.Errorf("update: close %q: %w", destPath, closeErr)
		}
	}

	if !found {
		return "", fmt.Errorf("update: tar %q contains no regular file", tarGzPath)
	}
	return destPath, nil
}

// ReleasesView returns targetName's current version and its filtered,
// sorted release list (BuildReleasesView), for GET /api/updates. current
// is best-effort: a CurrentVersion failure leaves it "" rather than
// failing the whole call. A ListReleases failure IS returned — GitHub
// being unreachable or rate-limited is worth surfacing — but current is
// still populated in that case so the caller can show a partial result.
func (e *Engine) ReleasesView(ctx context.Context, targetName string) (ReleasesView, error) {
	t, ok := e.targets[targetName]
	if !ok {
		return ReleasesView{}, ErrUnknownTarget
	}
	current, _ := t.CurrentVersion(ctx)

	releases, err := e.github.ListReleases(ctx, t.Repo(), e.githubToken)
	if err != nil {
		return ReleasesView{CurrentVersion: current}, err
	}
	matcher := NewAssetMatcher(assetBaseName(targetName), e.arch, e.variant)
	return BuildReleasesView(current, releases, matcher, e.maxNewer, e.maxOlder), nil
}

// LatestVersion returns the newest STABLE release version newer than
// targetName's current version, if any (ok=false when already up to date,
// the only newer releases are prereleases, or the release list has no
// matching newer asset).
//
// This is the auto-update picker (auto.go's tickTarget "apply" case, and
// CheckAndPublish's "check" notice) — spec 08-migration.md treats
// prereleases as opt-in betas the updater never auto-offers, so skipping
// them here (rather than in BuildReleasesView/ReleasesView) is
// deliberate: manual apply still lists and can install an RC, since
// handleApplyUpdate takes an explicit version from the operator rather
// than going through this function.
func (e *Engine) LatestVersion(ctx context.Context, targetName string) (version string, ok bool, err error) {
	view, err := e.ReleasesView(ctx, targetName)
	if err != nil {
		return "", false, err
	}
	for _, r := range view.Releases {
		if r.Newer && !r.Prerelease {
			return r.Version, true, nil
		}
	}
	return "", false, nil
}

// autoCheckEvent is published to the hub's "update" topic by auto-update's
// "check" mode (see auto.go) — distinct from runEventWire's "phase" shape,
// distinguished by callers on the presence of available_version instead.
type autoCheckEvent struct {
	Target           string `json:"target"`
	Mode             string `json:"mode"`
	CurrentVersion   string `json:"current_version"`
	AvailableVersion string `json:"available_version"`
}

// CheckAndPublish looks up targetName's latest newer release and, if one
// exists, publishes an availability notice to the hub's "update" topic.
// GitHub errors (including rate-limiting) are logged and otherwise
// swallowed — the 10-minute release cache in releases.go already limits
// how often this hits the real API, so there is no separate backoff here;
// a transient failure just means this tick reports nothing, and the next
// tick tries again.
func (e *Engine) CheckAndPublish(ctx context.Context, targetName string) {
	version, ok, err := e.LatestVersion(ctx, targetName)
	if err != nil {
		slog.Warn("auto-update: check", "target", targetName, "err", err)
		return
	}
	if !ok {
		return
	}

	current := ""
	if t, tok := e.targets[targetName]; tok {
		if cv, cerr := t.CurrentVersion(ctx); cerr == nil {
			current = cv
		}
	}

	data, err := json.Marshal(autoCheckEvent{Target: targetName, Mode: AutoModeCheck, CurrentVersion: current, AvailableVersion: version})
	if err != nil {
		slog.Error("auto-update: marshal check event", "err", err)
		return
	}
	if e.hub != nil {
		e.hub.PublishUpdate(data)
	}
}
