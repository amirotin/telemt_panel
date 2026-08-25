package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/amirotin/telemt_panel/internal/webui"
)

// fakeWebUI builds a webui.Handler over a minimal fstest.MapFS shaped like
// a real Vite build, so these tests exercise the SPA-vs-API-vs-subpage
// routing precedence in Handler() without depending on `make web` having
// actually run — internal/webui's own unit tests (webui_test.go) already
// cover the handler's internals in depth.
func fakeWebUI(t *testing.T, basePath string) http.Handler {
	t.Helper()
	h, err := webui.New(fstest.MapFS{
		"index.html": &fstest.MapFile{
			Data: []byte(`<!doctype html><html><head></head><body><div id="root"></div></body></html>`),
		},
		"assets/index-abc123.js": &fstest.MapFile{Data: []byte("console.log(1)")},
	}, basePath)
	if err != nil {
		t.Fatalf("webui.New: %v", err)
	}
	return h
}

func TestWebUIRootServesIndex(t *testing.T) {
	srv := newTestServer(t)
	srv.webUI = fakeWebUI(t, "")

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != 200 {
		t.Fatalf("status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `id="root"`) {
		t.Errorf("body = %s", rec.Body.String())
	}
}

func TestWebUISPARouteFallsBackToIndex(t *testing.T) {
	srv := newTestServer(t)
	srv.webUI = fakeWebUI(t, "")

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/some/spa/route", nil))
	if rec.Code != 200 {
		t.Fatalf("status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `id="root"`) {
		t.Errorf("body = %s", rec.Body.String())
	}
}

func TestWebUIHashedAssetImmutableCache(t *testing.T) {
	srv := newTestServer(t)
	srv.webUI = fakeWebUI(t, "")

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/assets/index-abc123.js", nil))
	if rec.Code != 200 {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Errorf("Cache-Control = %q", got)
	}
}

// TestWebUIDoesNotShadowAPIJSONFallback proves the SPA catch-all
// registered in Handler() leaves apiJSONFallback's behavior for an unknown
// /api/ path untouched — a JSON {code,message} 404, not the SPA's
// index.html.
func TestWebUIDoesNotShadowAPIJSONFallback(t *testing.T) {
	srv := newTestServer(t)
	srv.webUI = fakeWebUI(t, "")

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/nope", nil))
	if rec.Code != 404 {
		t.Fatalf("status = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	if strings.Contains(rec.Body.String(), "<html") {
		t.Errorf("body looks like the SPA fallback, not a JSON error: %s", rec.Body.String())
	}
}

// TestWebUIDoesNotShadowSubpage404 proves the SPA catch-all doesn't
// intercept a registered /sub/{token} route — an unknown token still gets
// the subpage handler's own plain-text 404, not index.html.
func TestWebUIDoesNotShadowSubpage404(t *testing.T) {
	srv := newTestServer(t)
	srv.cfg.Subpage.Enabled = true
	srv.cfg.Subpage.Secret = "test-subpage-secret"
	srv.webUI = fakeWebUI(t, "")

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/sub/bad-token", nil))
	if rec.Code != 404 {
		t.Fatalf("status = %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), `id="root"`) {
		t.Errorf("body looks like the SPA fallback, not the subpage 404: %s", rec.Body.String())
	}
}

func TestWebUIBasePathInjectedAcrossRoutes(t *testing.T) {
	srv := newTestServer(t)
	srv.cfg.BasePath = "/panel"
	srv.webUI = fakeWebUI(t, "/panel")

	for _, path := range []string{"/", "/users/alice"} {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		if rec.Code != 200 {
			t.Fatalf("%s: status = %d", path, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), `window.__BASE_PATH__="/panel"`) {
			t.Errorf("%s: missing base path injection: %s", path, rec.Body.String())
		}
	}

	// Behavior under base_path doesn't change for /api and /sub — the
	// panel's own routes are never mounted under the prefix (see
	// config.Config.BasePath's doc comment: a reverse proxy strips it
	// before forwarding).
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/nope", nil))
	if rec.Code != 404 || rec.Header().Get("Content-Type") != "application/json" {
		t.Errorf("/api/nope under base_path: status=%d content-type=%q", rec.Code, rec.Header().Get("Content-Type"))
	}
}

// TestWebUISubpageWrongMethodGetsSubpageOwn405 covers fix round 1, finding
// 4: a non-GET request to a registered /sub/{token} route must get the
// subpage handler's own 405 (via mux, same as pre-M3), not webUI's
// generic "method not allowed" — spaRouter routes the whole /sub
// namespace to mux unconditionally, regardless of method.
func TestWebUISubpageWrongMethodGetsSubpageOwn405(t *testing.T) {
	srv := newTestServer(t)
	srv.cfg.Subpage.Enabled = true
	srv.cfg.Subpage.Secret = "test-subpage-secret"
	srv.webUI = fakeWebUI(t, "")

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest("POST", "/sub/bad-token", nil))
	if rec.Code != 405 {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
	if strings.Contains(rec.Body.String(), `id="root"`) {
		t.Errorf("body looks like the SPA fallback, not the subpage's own 405: %s", rec.Body.String())
	}
}

// TestWebUIBareAPIPath404sAsJSON and TestWebUIBareSubPath404 cover fix
// round 1, finding 5: a bare "/api" or "/sub" (no trailing slash) used to
// fall through to webUI's SPA shell (200) once the SPA catch-all existed.
// Both must 404 in their namespace's own style instead.
func TestWebUIBareAPIPath404sAsJSON(t *testing.T) {
	srv := newTestServer(t)
	srv.webUI = fakeWebUI(t, "")

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api", nil))
	if rec.Code != 404 {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
}

func TestWebUIBareSubPath404(t *testing.T) {
	srv := newTestServer(t)
	srv.cfg.Subpage.Enabled = true
	srv.cfg.Subpage.Secret = "test-subpage-secret"
	srv.webUI = fakeWebUI(t, "")

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/sub", nil))
	if rec.Code != 404 {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q, want plain text (mux's own 404, not the JSON API envelope)", ct)
	}
	if strings.Contains(rec.Body.String(), `id="root"`) {
		t.Errorf("body looks like the SPA fallback: %s", rec.Body.String())
	}
}
