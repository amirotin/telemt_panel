package webui

import (
	"bytes"
	"encoding/json"
	"html"
	"net/http"
	"sync"

	"github.com/amirotin/telemt_panel/internal/branding"
)

type appearanceCache struct {
	mu      sync.Mutex
	current branding.Public
	index   []byte
	etag    string
}

// SetBranding attaches a public appearance provider before serving requests.
func (h *Handler) SetBranding(provider func() branding.Public) { h.branding = provider }

func (h *Handler) brandedIndex() ([]byte, string) {
	if h.branding == nil {
		return h.index, h.indexETag
	}
	p := h.branding()
	c := &h.appearance
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.index != nil && c.current == p {
		return c.index, c.etag
	}
	body := bytes.Replace(h.index, []byte("<title>Telemt Panel</title>"), []byte("<title>"+html.EscapeString(p.Title)+"</title>"), 1)
	body = bytes.Replace(body, []byte(`name="apple-mobile-web-app-title" content="Telemt Panel"`), []byte(`name="apple-mobile-web-app-title" content="`+html.EscapeString(p.Title)+`"`), 1)
	if p.IconURL != "" {
		body = bytes.Replace(body, []byte(`href="icon.svg" type="image/svg+xml"`), []byte(`href="`+html.EscapeString(p.IconURL)+`" type="image/png"`), 1)
		body = bytes.Replace(body, []byte(`href="apple-touch-icon.png"`), []byte(`href="`+html.EscapeString(p.IconURL)+`"`), 1)
	}
	encoded, _ := json.Marshal(p)
	body = bytes.Replace(body, []byte("</head>"), []byte("<script>window.__PANEL_BRANDING__="+string(encoded)+"</script></head>"), 1)
	c.current, c.index, c.etag = p, body, etagOf(body)
	return c.index, c.etag
}

func (h *Handler) serveBrandedManifest(w http.ResponseWriter, r *http.Request) {
	p := h.branding()
	if p.Title == "Telemt Panel" && p.LogoMode == "default" {
		if etag, ok := h.assetETags["manifest.webmanifest"]; ok {
			h.serveAsset(w, r, "manifest.webmanifest", etag)
			return
		}
	}
	icons := []map[string]string{{"src": "icon.svg", "sizes": "any", "type": "image/svg+xml"}, {"src": "icon-192.png", "sizes": "192x192", "type": "image/png"}, {"src": "icon-512.png", "sizes": "512x512", "type": "image/png"}}
	if p.IconURL != "" {
		icons = []map[string]string{{"src": p.IconURL, "sizes": "192x192", "type": "image/png"}, {"src": p.IconURL + "&size=512", "sizes": "512x512", "type": "image/png"}}
	}
	body, _ := json.Marshal(map[string]any{"name": p.Title, "short_name": p.Title, "id": ".", "start_url": ".", "scope": ".", "display": "standalone", "theme_color": "#12171d", "background_color": "#12171d", "icons": icons})
	w.Header().Set("Content-Type", "application/manifest+json")
	w.Header().Set("Cache-Control", "no-cache")
	etag := etagOf(body)
	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}
