package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"time"
)

// defaultBaseURL is the real GitHub API host. Tests override Client.BaseURL
// to point at an httptest fake instead.
const defaultBaseURL = "https://api.github.com"

// cacheTTL is how long a repo's release list is reused before refetching —
// keeps two browser tabs polling /api/updates from each burning GitHub's
// rate limit.
const cacheTTL = 10 * time.Minute

// Release is a GitHub release, decoded down to the fields the update engine
// needs.
type Release struct {
	Tag         string    `json:"tag_name"`
	Name        string    `json:"name"`
	Prerelease  bool      `json:"prerelease"`
	Draft       bool      `json:"draft"`
	PublishedAt time.Time `json:"published_at"`
	Assets      []Asset   `json:"assets"`
}

// Client lists GitHub releases with a per-repo cache.
type Client struct {
	HTTPClient *http.Client
	// Now returns the current time; injectable so tests can control cache
	// expiry without real sleeps. Defaults to time.Now.
	Now func() time.Time
	// BaseURL overrides the GitHub API base URL. Defaults to
	// defaultBaseURL; tests point it at an httptest fake.
	BaseURL string

	mu      sync.Mutex
	cache   map[string]cacheEntry
	pending map[string]*releaseFetch
}

type cacheEntry struct {
	releases []Release
	err      error
	expires  time.Time
}

type releaseFetch struct {
	done           chan struct{}
	result         cacheEntry
	leaderCanceled bool
}

// NewClient returns a Client with a 30s-timeout HTTP client and the real
// clock.
func NewClient() *Client {
	return &Client{
		HTTPClient: &http.Client{Timeout: 30 * time.Second},
		Now:        time.Now,
		cache:      make(map[string]cacheEntry),
	}
}

// ListReleases fetches non-draft releases for repo (format "owner/repo")
// from the GitHub API, using a per-repo cache valid for cacheTTL. token,
// when non-empty, is sent as "Authorization: Bearer <token>" to raise the
// rate limit; the cache key ignores it since a repo's release list is the
// same regardless of which caller's token fetched it.
func (c *Client) ListReleases(ctx context.Context, repo, token string) ([]Release, error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		c.mu.Lock()
		if c.cache == nil {
			c.cache = make(map[string]cacheEntry)
		}
		if entry, ok := c.cache[repo]; ok && c.now().Before(entry.expires) {
			c.mu.Unlock()
			return entry.releases, entry.err
		}
		if running := c.pending[repo]; running != nil {
			c.mu.Unlock()
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-running.done:
				// A canceled leader does not spend a waiter's live request.
				if running.leaderCanceled {
					continue
				}
				return running.result.releases, running.result.err
			}
		}
		if c.pending == nil {
			c.pending = make(map[string]*releaseFetch)
		}
		running := &releaseFetch{done: make(chan struct{})}
		c.pending[repo] = running
		c.mu.Unlock()

		result := c.fetch(ctx, repo, token)
		c.mu.Lock()
		running.result = result
		running.leaderCanceled = result.err != nil && ctx.Err() != nil
		if !result.expires.IsZero() {
			c.cache[repo] = result
		}
		delete(c.pending, repo)
		close(running.done)
		c.mu.Unlock()
		return result.releases, result.err
	}
}

func (c *Client) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func (c *Client) baseURL() string {
	if c.BaseURL != "" {
		return c.BaseURL
	}
	return defaultBaseURL
}

func (c *Client) fetch(ctx context.Context, repo, token string) cacheEntry {
	url := fmt.Sprintf("%s/repos/%s/releases?per_page=30", c.baseURL(), repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return cacheEntry{err: fmt.Errorf("create request: %w", err)}
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	httpClient := c.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return cacheEntry{err: fmt.Errorf("fetch releases: %w", err)}
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		entry := cacheEntry{err: fmt.Errorf("github API returned %d for %s", resp.StatusCode, repo)}
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusForbidden {
			entry.expires = releaseRetryAt(resp, c.now())
		}
		return entry
	}
	const maxCatalogBytes = 4 << 20
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxCatalogBytes+1))
	if err != nil {
		return cacheEntry{err: fmt.Errorf("read releases: %w", err)}
	}
	if len(data) > maxCatalogBytes {
		return cacheEntry{err: errors.New("release catalog exceeds size limit")}
	}
	var all []Release
	if err := json.Unmarshal(data, &all); err != nil {
		return cacheEntry{err: fmt.Errorf("decode releases: %w", err)}
	}

	releases := make([]Release, 0, len(all))
	for _, r := range all {
		if r.Draft {
			continue
		}
		releases = append(releases, r)
	}
	return cacheEntry{releases: releases, expires: c.now().Add(cacheTTL)}
}

func releaseRetryAt(resp *http.Response, now time.Time) time.Time {
	retry := resp.Header.Get("Retry-After")
	if seconds, err := strconv.ParseInt(retry, 10, 32); err == nil && seconds >= 0 {
		return now.Add(time.Duration(seconds) * time.Second)
	}
	if date, err := http.ParseTime(retry); err == nil && date.After(now) {
		return date
	}
	if resp.Header.Get("X-RateLimit-Remaining") == "0" {
		if seconds, err := strconv.ParseInt(resp.Header.Get("X-RateLimit-Reset"), 10, 64); err == nil && seconds > now.Unix() {
			return time.Unix(seconds, 0)
		}
		return now.Add(time.Minute)
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		return now.Add(time.Minute)
	}
	return time.Time{}
}

// ReleaseView is one release as presented to callers, with the
// current-version comparison and asset selection already applied.
type ReleaseView struct {
	Version          string
	Name             string
	PublishedAt      time.Time
	Prerelease       bool
	Newer            bool
	Asset            Asset
	ChecksumAsset    *Asset
	ChecksumRequired bool `json:"checksum_required"`
}

// ReleasesView is the filtered, sorted release list for one target.
type ReleasesView struct {
	CurrentVersion string
	Releases       []ReleaseView
}

// BuildReleasesView filters releases down to those with a matching asset
// (via match) and a version different from current, sorts the rest by
// semver descending, and returns up to maxNewer releases newer than current
// plus up to maxOlder releases older than current. maxNewer/maxOlder <= 0
// means unlimited in that direction.
func BuildReleasesView(current string, releases []Release, match AssetMatcher, maxNewer, maxOlder int) ReleasesView {
	type scored struct {
		view ReleaseView
		cmp  int // vs current: >0 newer, <0 older
	}

	var items []scored
	for _, r := range releases {
		bin, sum := match(r.Assets)
		if bin == nil {
			continue
		}
		cmp := CompareVersions(r.Tag, current)
		if cmp == 0 {
			continue
		}
		items = append(items, scored{
			view: ReleaseView{
				Version:       r.Tag,
				Name:          r.Name,
				PublishedAt:   r.PublishedAt,
				Prerelease:    r.Prerelease,
				Newer:         cmp > 0,
				Asset:         *bin,
				ChecksumAsset: sum,
			},
			cmp: cmp,
		})
	}

	sort.Slice(items, func(i, j int) bool {
		return CompareVersions(items[i].view.Version, items[j].view.Version) > 0
	})

	var result []ReleaseView
	newerCount, olderCount := 0, 0
	for _, item := range items {
		if item.cmp > 0 {
			if maxNewer <= 0 || newerCount < maxNewer {
				result = append(result, item.view)
				newerCount++
			}
		} else {
			if maxOlder <= 0 || olderCount < maxOlder {
				result = append(result, item.view)
				olderCount++
			}
		}
	}

	return ReleasesView{CurrentVersion: current, Releases: result}
}
