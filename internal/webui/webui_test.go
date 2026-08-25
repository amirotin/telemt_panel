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

// Fix round 1, finding 1: an unmatched path under assets/ (Vite's own
// content-hashed namespace) must 404, not silently serve the SPA shell as
// if it were a valid client-side route — a stale/wrong asset reference is
// a real error, not a page to render.
func TestUnknownAssetPath404s(t *testing.T) {
	h, err := New(fixtureFS(), "")
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/assets/missing.js", nil))
	if rec.Code != 404 {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Errorf("Content-Type = %q, want text/plain", ct)
	}
	if strings.Contains(rec.Body.String(), `id="root"`) {
		t.Errorf("body looks like the SPA fallback, not a 404: %s", rec.Body.String())
	}
}

// Fix round 1, finding 1: a missing top-level, well-known static file
// (favicon.ico — browsers request it unprompted) must also 404 rather
// than fall back to the SPA shell.
func TestMissingTopLevelStaticFile404s(t *testing.T) {
	h, err := New(fixtureFS(), "")
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/favicon.ico", nil))
	if rec.Code != 404 {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

// Fix round 1, finding 1: an extension-less SPA route still falls back to
// index.html — the 404 rule above must not regress this.
func TestExtensionlessRouteStillFallsBackToIndex(t *testing.T) {
	h, err := New(fixtureFS(), "")
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/users", nil))
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `id="root"`) {
		t.Errorf("expected index.html fallback body, got: %s", rec.Body.String())
	}
}

// Fix round 1, finding 1: a multi-segment SPA route whose last segment
// happens to contain a dot (a legitimate username, e.g. "alice.smith")
// must still reach the SPA — the extension-based 404 rule is scoped to
// top-level paths only, precisely to avoid breaking this.
func TestDottedRouteSegmentStillFallsBackToIndex(t *testing.T) {
	h, err := New(fixtureFS(), "")
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/users/alice.smith", nil))
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `id="root"`) {
		t.Errorf("expected index.html fallback body, got: %s", rec.Body.String())
	}
}

// Fix round 1, finding 2: patchIndex must render inert output even for a
// basePath value crafted to break out of the <base href> attribute and
// the inline <script> body — defense-in-depth behind
// config.validateBasePath actually rejecting this value at load (see
// internal/config's TestLoadRejectsScriptInjectionBasePath).
func TestPatchIndexEscapesHostileBasePath(t *testing.T) {
	const hostile = `/pa"nel</script><script>alert(1)</script>`
	h, err := New(fixtureFS(), hostile)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	body := rec.Body.String()

	if strings.Contains(body, "</script><script>alert(1)</script>") {
		t.Errorf("raw payload broke out of the injected <script>: %s", body)
	}
	// The <base href="..."> attribute must stay a single well-formed
	// attribute: no unescaped '"' inside the value able to close it early.
	const attrStart = `<base href="`
	i := strings.Index(body, attrStart)
	if i < 0 {
		t.Fatalf("missing <base href>: %s", body)
	}
	rest := body[i+len(attrStart):]
	j := strings.Index(rest, `"`)
	if j < 0 {
		t.Fatalf("unterminated <base href> attribute: %s", body)
	}
	attrValue := rest[:j]
	if strings.ContainsAny(attrValue, `<>`) {
		t.Errorf("<base href> attribute value contains unescaped markup: %q", attrValue)
	}
}
