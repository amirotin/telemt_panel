package webui

import "embed"

// distFS holds the built SPA (index.html, assets/*, manifest, icons) —
// web/vite.config.ts's outDir points straight here, so `npm run build` (the
// Makefile "web" target) populates this directory in place with no v0-style
// copy/symlink step between the frontend build and go:embed.
//
// "all:" is required so that a fresh checkout — before "make web" has run —
// still compiles: dist/ then holds only the committed dist/.gitkeep
// placeholder, a dot-prefixed file go:embed excludes unless the pattern
// carries the "all:" prefix. Without it, `go build ./...` on a clean
// checkout fails with "pattern dist: no matching files found" — the exact
// v0 lesson (see v0/embed.go and its Makefile's frontend-before-backend
// ordering) this layout is written to avoid hitting again.
//
//go:embed all:dist
var distFS embed.FS
