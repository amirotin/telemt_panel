package webui

import (
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

// fixtureFS builds a minimal fstest.MapFS shaped like a real Vite build:
// index.html plus one content-hashed asset.
func fixtureFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html": &fstest.MapFile{
			Data: []byte("<!doctype html><html><head><title>Telemt Panel</title></head><body><div id=\"root\"></div></body></html>"),
		},
		"assets/index-abc123.js": &fstest.MapFile{
			Data: []byte("console.log('hi')"),
		},
		"manifest.webmanifest": &fstest.MapFile{
			Data: []byte(`{"name":"Telemt Panel"}`),
		},
	}
}

func TestServeIndexAtRoot(t *testing.T) {
	h, err := New(fixtureFS(), "")
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != 200 {
		t.Fatalf("status = %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "<div id=\"root\">") {
		t.Errorf("body missing app root: %s", body)
	}
	if !strings.Contains(body, `window.__BASE_PATH__=""`) {
		t.Errorf("body missing base path injection: %s", body)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("Cache-Control = %q", got)
	}
	if rec.Header().Get("ETag") == "" {
		t.Error("missing ETag")
	}
}

func TestSPAFallbackForClientRoute(t *testing.T) {
	h, err := New(fixtureFS(), "")
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/users/alice", nil))
	if rec.Code != 200 {
		t.Fatalf("status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "<div id=\"root\">") {
		t.Errorf("expected index.html fallback body, got: %s", rec.Body.String())
	}
}

func TestServeHashedAssetImmutable(t *testing.T) {
	h, err := New(fixtureFS(), "")
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/assets/index-abc123.js", nil))
	if rec.Code != 200 {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Errorf("Cache-Control = %q", got)
	}
	if rec.Body.String() != "console.log('hi')" {
		t.Errorf("body = %q", rec.Body.String())
	}
}

func TestNonAssetFileNoCache(t *testing.T) {
	h, err := New(fixtureFS(), "")
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/manifest.webmanifest", nil))
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("Cache-Control = %q", got)
	}
}

func TestETagRevalidation(t *testing.T) {
	h, err := New(fixtureFS(), "")
	if err != nil {
		t.Fatal(err)
	}
	first := httptest.NewRecorder()
	h.ServeHTTP(first, httptest.NewRequest("GET", "/assets/index-abc123.js", nil))
	etag := first.Header().Get("ETag")
	if etag == "" {
		t.Fatal("missing ETag on first response")
	}

	req := httptest.NewRequest("GET", "/assets/index-abc123.js", nil)
	req.Header.Set("If-None-Match", etag)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 304 {
		t.Fatalf("status = %d, want 304", rec.Code)
	}
}

func TestBasePathInjection(t *testing.T) {
	h, err := New(fixtureFS(), "/panel")
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	body := rec.Body.String()
	if !strings.Contains(body, `<base href="/panel/">`) {
		t.Errorf("missing base href injection: %s", body)
	}
	if !strings.Contains(body, `window.__BASE_PATH__="/panel"`) {
		t.Errorf("missing __BASE_PATH__ injection: %s", body)
	}
}

func TestMissingIndexServes503(t *testing.T) {
	// Simulates a checkout that hasn't run `make web` — only the
	// dist/.gitkeep placeholder exists, so index.html is absent.
	h, err := New(fstest.MapFS{}, "")
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != 503 {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

func TestMethodNotAllowed(t *testing.T) {
	h, err := New(fixtureFS(), "")
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/", nil))
	if rec.Code != 405 {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
}

func TestEmbeddedDistExists(t *testing.T) {
	// Proves the go:embed directive + "all:" prefix actually work against
	// the committed placeholder (or a real build, if one happens to be
	// present) without panicking.
	fsys := Embedded()
	if _, err := fsys.Open("."); err != nil {
		t.Fatalf("embedded dist root not openable: %v", err)
	}
}
