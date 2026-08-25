// Package webui serves the single-page application built by web/ (React +
// Vite, see web/README.md) as the panel's own HTTP handler: SPA fallback
// for client-side routing, base_path injection for reverse-proxy sub-path
// deployments, and cache headers/ETags for the built assets.
package webui

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"net/http"
	"strconv"
	"strings"
)

// Embedded returns the built SPA's filesystem root (the embedded dist/
// directory's contents, rooted at "index.html", "assets/...", etc).
//
// fs.Sub only errors when the given root doesn't exist in the parent
// filesystem, which cannot happen here: "dist" is always present in
// distFS, either as a real build (after `make web`) or as the committed
// dist/.gitkeep placeholder — see embed.go. A failure would mean the
// go:embed directive itself is broken, which fails the build, not this
// call.
func Embedded() fs.FS {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic("webui: embedded dist/ missing: " + err.Error())
	}
	return sub
}

// Handler serves the built SPA: known files (index.html, assets/*, PWA
// manifest/icons) are served with cache headers and ETags; every other
// path falls back to index.html so the SPA's client-side router
// (TanStack Router) resolves the route in the browser instead of getting a
// 404 on refresh/deep-link.
type Handler struct {
	fsys     fs.FS
	fileServ http.Handler

	// index is index.html with base_path injected (see patchIndex), or nil
	// on a checkout that hasn't run `make web` yet (dist/ holds only the
	// placeholder) — ServeHTTP degrades to 503 rather than panicking.
	index     []byte
	indexETag string

	// assetETags maps every non-index.html file's slash-path (relative to
	// fsys, no leading "/") to a content ETag, computed once at
	// construction since embedded content never changes at runtime. Its
	// keys double as the "does this path exist as a real file" check that
	// decides file-serve vs. SPA-fallback in ServeHTTP.
	assetETags map[string]string
}

// New builds a Handler over fsys (the dist subtree — production code
// passes Embedded(), tests pass an fstest.MapFS). basePath is
// config.Config.BasePath: "" or a leading-slash, no-trailing-slash prefix
// (see internal/config.Config.BasePath's normalization) that a reverse
// proxy strips before forwarding to the panel — the SPA needs it anyway to
// prefix its own /api and /sub requests to match what the browser's
// address bar shows through that proxy.
func New(fsys fs.FS, basePath string) (*Handler, error) {
	h := &Handler{fsys: fsys, fileServ: http.FileServer(http.FS(fsys))}

	raw, err := fs.ReadFile(fsys, "index.html")
	switch {
	case errors.Is(err, fs.ErrNotExist):
		h.index = nil
	case err != nil:
		return nil, err
	default:
		h.index = patchIndex(raw, basePath)
	}
	h.indexETag = etagOf(h.index)

	h.assetETags = map[string]string{}
	err = fs.WalkDir(fsys, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || path == "index.html" {
			return nil
		}
		b, readErr := fs.ReadFile(fsys, path)
		if readErr != nil {
			return nil
		}
		h.assetETags[path] = etagOf(b)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return h, nil
}

// patchIndex injects a <base href> and window.__BASE_PATH__ right after
// <head>, mirroring v0's internal/spa approach: Vite's base:"./" build
// (vite.config.ts) already makes every asset URL in index.html relative to
// the document itself, so the <base> tag alone gets those right under any
// basePath with no per-URL rewriting; window.__BASE_PATH__ is read by
// web/src/lib/api.ts and the router setup so the SPA's own /api and /sub
// requests carry the prefix too.
func patchIndex(raw []byte, basePath string) []byte {
	href := basePath + "/"
	injection := `<base href="` + href + `">` +
		`<script>window.__BASE_PATH__=` + strconv.Quote(basePath) + `</script>`
	return bytes.Replace(raw, []byte("<head>"), []byte("<head>"+injection), 1)
}

func etagOf(b []byte) string {
	sum := sha256.Sum256(b)
	return `"` + hex.EncodeToString(sum[:12]) + `"`
}

// ServeHTTP implements http.Handler.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	p := strings.TrimPrefix(r.URL.Path, "/")
	if p == "" {
		p = "index.html"
	}

	if etag, ok := h.assetETags[p]; ok && p != "index.html" {
		h.serveAsset(w, r, p, etag)
		return
	}
	h.serveIndex(w, r)
}

// serveAsset serves a real file from fsys: immutable long-lived caching
// under assets/ (Vite content-hashes those filenames, so a changed file is
// a changed URL — safe to cache forever), no-cache elsewhere (e.g. the PWA
// manifest, icons — same-URL files that can change on a redeploy), and an
// ETag either way for cheap revalidation.
func (h *Handler) serveAsset(w http.ResponseWriter, r *http.Request, p, etag string) {
	if strings.HasPrefix(p, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	w.Header().Set("ETag", etag)
	if match := r.Header.Get("If-None-Match"); match != "" && match == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	h.fileServ.ServeHTTP(w, r)
}

// serveIndex serves the (patched) index.html for "/", for any unmatched
// SPA route, and for "/index.html" itself. no-cache (not immutable/long
// max-age — this file's content changes across deploys but keeps its URL)
// with ETag revalidation.
func (h *Handler) serveIndex(w http.ResponseWriter, r *http.Request) {
	if h.index == nil {
		http.Error(w, "frontend not built — run `make web`", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("ETag", h.indexETag)
	if match := r.Header.Get("If-None-Match"); match != "" && match == h.indexETag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(h.index)
}
