// This module has no Go code of its own — it exists solely as a module
// boundary so `go build/vet/test ./...` run from the repo root (internal/
// httpapi's actual Go module) never descends into web/node_modules, which
// can contain vendored Go source shipped inside an npm package (observed:
// a JS testing dependency bundles a Go port of itself). Without this
// boundary, a future `npm install` could silently break the panel's own
// `go build ./...`/`go vet ./...` on code this project doesn't own. gofmt
// doesn't respect module boundaries either way — see Makefile's `lint`
// target, which scopes gofmt to git-tracked files instead.
module telemt_panel_web_boundary

go 1.24
