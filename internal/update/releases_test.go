package update

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func newFakeGitHub(t *testing.T, releases []Release, gotAuth *[]string) *httptest.Server {
	t.Helper()
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		*gotAuth = append(*gotAuth, r.Header.Get("Authorization"))
		if got := r.URL.Query().Get("per_page"); got != "30" {
			t.Errorf("per_page = %q, want 30", got)
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(releases); err != nil {
			t.Fatalf("encode fixture: %v", err)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestListReleases_FiltersDraftsAndSendsTokenHeader(t *testing.T) {
	fixture := []Release{
		{Tag: "v1.1.0", Name: "1.1.0", PublishedAt: time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)},
		{Tag: "v1.2.0-draft", Draft: true},
		{Tag: "v1.0.0-rc1", Prerelease: true},
	}
	var gotAuth []string
	srv := newFakeGitHub(t, fixture, &gotAuth)

	c := NewClient()
	c.BaseURL = srv.URL

	releases, err := c.ListReleases(context.Background(), "owner/repo", "tok123")
	if err != nil {
		t.Fatalf("ListReleases: %v", err)
	}
	if len(releases) != 2 {
		t.Fatalf("got %d releases, want 2 (draft filtered): %+v", len(releases), releases)
	}
	for _, r := range releases {
		if r.Draft {
			t.Errorf("draft release leaked through: %+v", r)
		}
	}
	if len(gotAuth) != 1 || gotAuth[0] != "Bearer tok123" {
		t.Errorf("Authorization header = %v, want [\"Bearer tok123\"]", gotAuth)
	}
}

func TestListReleases_NoTokenOmitsAuthHeader(t *testing.T) {
	var gotAuth []string
	srv := newFakeGitHub(t, nil, &gotAuth)

	c := NewClient()
	c.BaseURL = srv.URL

	if _, err := c.ListReleases(context.Background(), "owner/repo", ""); err != nil {
		t.Fatalf("ListReleases: %v", err)
	}
	if len(gotAuth) != 1 || gotAuth[0] != "" {
		t.Errorf("Authorization header = %v, want empty", gotAuth)
	}
}

func TestListReleases_CachesPerRepoUntilInjectedClockAdvances(t *testing.T) {
	var gotAuth []string
	srv := newFakeGitHub(t, []Release{{Tag: "v1.0.0"}}, &gotAuth)

	c := NewClient()
	c.BaseURL = srv.URL
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	c.Now = func() time.Time { return now }

	if _, err := c.ListReleases(context.Background(), "owner/repo", ""); err != nil {
		t.Fatalf("first ListReleases: %v", err)
	}
	if _, err := c.ListReleases(context.Background(), "owner/repo", ""); err != nil {
		t.Fatalf("second ListReleases: %v", err)
	}
	if len(gotAuth) != 1 {
		t.Fatalf("hits = %d within TTL, want 1 (second call served from cache)", len(gotAuth))
	}

	// Different repo: not cached, must hit the server again.
	if _, err := c.ListReleases(context.Background(), "owner/other", ""); err != nil {
		t.Fatalf("other repo ListReleases: %v", err)
	}
	if len(gotAuth) != 2 {
		t.Fatalf("hits = %d after distinct repo, want 2", len(gotAuth))
	}

	// Advance the injected clock past the 10-minute TTL: must refetch.
	now = now.Add(cacheTTL + time.Second)
	if _, err := c.ListReleases(context.Background(), "owner/repo", ""); err != nil {
		t.Fatalf("ListReleases after TTL: %v", err)
	}
	if len(gotAuth) != 3 {
		t.Fatalf("hits = %d after TTL expiry, want 3", len(gotAuth))
	}
}

func TestListReleases_NonOKStatusIsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	t.Cleanup(srv.Close)

	c := NewClient()
	c.BaseURL = srv.URL
	if _, err := c.ListReleases(context.Background(), "owner/repo", ""); err == nil {
		t.Fatal("expected error on non-200 response")
	}
}

func telemtMatcher() AssetMatcher {
	return NewAssetMatcher("telemt", "x86_64", "gnu")
}

func TestBuildReleasesView(t *testing.T) {
	match := telemtMatcher()
	binAsset := Asset{Name: "telemt-x86_64-linux-gnu.tar.gz"}
	sumAsset := Asset{Name: "telemt-x86_64-linux-gnu.tar.gz.sha256"}

	releases := []Release{
		{Tag: "v1.3.0", PublishedAt: time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC), Assets: []Asset{binAsset, sumAsset}},
		{Tag: "v1.2.0", Assets: []Asset{binAsset, sumAsset}},                        // current, must be excluded
		{Tag: "v1.1.0", Assets: []Asset{binAsset, sumAsset}},                        // older
		{Tag: "v1.0.0", Assets: []Asset{binAsset, sumAsset}},                        // older
		{Tag: "v1.4.0-rc1", Prerelease: true, Assets: []Asset{binAsset, sumAsset}},  // newer, prerelease
		{Tag: "v1.5.0", Assets: []Asset{{Name: "telemt-aarch64-linux-gnu.tar.gz"}}}, // no matching asset, excluded
	}

	view := BuildReleasesView("v1.2.0", releases, match, 10, 10)

	if view.CurrentVersion != "v1.2.0" {
		t.Fatalf("CurrentVersion = %q", view.CurrentVersion)
	}
	if len(view.Releases) != 4 {
		t.Fatalf("got %d releases, want 4: %+v", len(view.Releases), view.Releases)
	}

	// Sorted descending by semver: v1.4.0-rc1, v1.3.0, v1.1.0, v1.0.0.
	wantOrder := []string{"v1.4.0-rc1", "v1.3.0", "v1.1.0", "v1.0.0"}
	for i, r := range view.Releases {
		if r.Version != wantOrder[i] {
			t.Errorf("Releases[%d].Version = %q, want %q", i, r.Version, wantOrder[i])
		}
	}

	if !view.Releases[0].Prerelease {
		t.Errorf("v1.4.0-rc1 should be flagged Prerelease")
	}
	if !view.Releases[0].Newer {
		t.Errorf("v1.4.0-rc1 should be flagged Newer")
	}
	if view.Releases[2].Newer {
		t.Errorf("v1.1.0 should not be flagged Newer")
	}
	if view.Releases[0].ChecksumAsset == nil || view.Releases[0].ChecksumAsset.Name != sumAsset.Name {
		t.Errorf("ChecksumAsset = %+v, want %+v", view.Releases[0].ChecksumAsset, sumAsset)
	}
}

func TestBuildReleasesView_RespectsLimits(t *testing.T) {
	match := telemtMatcher()
	bin := Asset{Name: "telemt-x86_64-linux-gnu.tar.gz"}

	releases := []Release{
		{Tag: "v1.4.0", Assets: []Asset{bin}},
		{Tag: "v1.3.0", Assets: []Asset{bin}},
		{Tag: "v1.2.0", Assets: []Asset{bin}}, // current
		{Tag: "v1.1.0", Assets: []Asset{bin}},
		{Tag: "v1.0.0", Assets: []Asset{bin}},
	}

	view := BuildReleasesView("v1.2.0", releases, match, 1, 1)
	if len(view.Releases) != 2 {
		t.Fatalf("got %d releases, want 2 (1 newer + 1 older): %+v", len(view.Releases), view.Releases)
	}
	if view.Releases[0].Version != "v1.4.0" {
		t.Errorf("newer slot = %q, want v1.4.0", view.Releases[0].Version)
	}
	if view.Releases[1].Version != "v1.1.0" {
		t.Errorf("older slot = %q, want v1.1.0", view.Releases[1].Version)
	}
}
