VERSION ?= 0.0.0-dev
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: build test lint release clean mock web dev-frontend dev-backend

# Builds the SPA straight into internal/webui/dist (web/vite.config.ts's
# outDir) — the package's go:embed directive picks it up with no
# copy/symlink step. `build` and `release` depend on this so `go:embed`
# never sees a stale or placeholder-only dist/ (the v0 lesson: frontend
# before backend, always — see internal/webui/embed.go).
web:
	cd web && npm ci && npm run build

build: web
	CGO_ENABLED=0 go build -ldflags="$(LDFLAGS)" -o telemt-panel ./cmd/panel

# Frontend dev server (vite) — proxies /api and /sub to dev-backend below.
dev-frontend:
	cd web && npm run dev

# Panel against config.toml (copy config.example.toml; point [telemt].url
# at `make mock`'s :9091 for a frontend-only dev loop with no real Telemt).
# Serves whatever is currently in internal/webui/dist — run `make web`
# first, or just use dev-frontend for frontend work instead.
dev-backend:
	go run ./cmd/panel --config config.toml

# -race matches CI; it needs cgo (a C toolchain), unlike the pure-Go
# CGO_ENABLED=0 release builds.
test:
	go test -race ./...

# Dev-only fake Telemt API (internal/telemt/telemttest), replacing the 0.x
# panel's .claude/mock-server.mjs — point telemt.url at it (default
# http://127.0.0.1:9091) to run the panel/frontend without a real Telemt.
# Never part of `release` — see that target and TestReleaseContract.
mock:
	go run ./cmd/telemt-mock -listen :9091 -scenario full

# Single source of truth for formatting/vet — CI invokes this target.
# gofmt runs over git-tracked *.go files only, not `.` — since M3
# (internal/webui) web/node_modules can contain vendored Go source (e.g.
# npm packages that ship a Go implementation alongside their JS one),
# which a bare `gofmt -l .` would scan and could fail lint on with a
# future npm dependency bump, for formatting this project doesn't own.
# git ls-files naturally excludes it (node_modules is gitignored) without
# needing to enumerate exclusions.
# The || guard propagates gofmt's own failure (e.g. an unparseable file),
# which exits non-zero with nothing on stdout.
lint:
	@out="$$(gofmt -l $$(git ls-files '*.go'))" || { echo "gofmt failed"; exit 1; }; \
	if [ -n "$$out" ]; then \
		echo "Files not formatted with gofmt:"; \
		echo "$$out"; \
		exit 1; \
	fi
	@go vet ./...

# Static binaries for every supported target, router SoCs included, packaged
# for internal/update's AssetMatcher (telemt-panel-<arch>-linux-<variant>.tar.gz
# + <asset>.sha256, one file named telemt-panel per tarball). The panel is a
# pure-Go static binary, so it's variant-independent: gnu and musl tarballs
# carry identical content — this is what keeps the release installable on
# both libc families while matching the 0.x-updater-compatible naming from
# migration spec 08-migration.md. panel-agent ships as raw per-arch binaries
# (not packaged, not matched by the updater) for future host provisioning.
# Depends on `web` so the frontend is built exactly once, ahead of every
# per-arch Go build below (they all embed the same internal/webui/dist).
release: web
	@rm -rf release/.stage
	@mkdir -p release/.stage
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -o release/.stage/x86_64/telemt-panel ./cmd/panel
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="$(LDFLAGS)" -o release/.stage/aarch64/telemt-panel ./cmd/panel
	CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 go build -ldflags="$(LDFLAGS)" -o release/.stage/armv7/telemt-panel ./cmd/panel
	CGO_ENABLED=0 GOOS=linux GOARCH=mipsle GOMIPS=softfloat go build -ldflags="$(LDFLAGS)" -o release/.stage/mipsle/telemt-panel ./cmd/panel
	CGO_ENABLED=0 GOOS=linux GOARCH=mips GOMIPS=softfloat go build -ldflags="$(LDFLAGS)" -o release/.stage/mips/telemt-panel ./cmd/panel
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -o release/panel-agent-x86_64-linux ./cmd/panel-agent
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="$(LDFLAGS)" -o release/panel-agent-aarch64-linux ./cmd/panel-agent
	CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 go build -ldflags="$(LDFLAGS)" -o release/panel-agent-armv7-linux ./cmd/panel-agent
	CGO_ENABLED=0 GOOS=linux GOARCH=mipsle GOMIPS=softfloat go build -ldflags="$(LDFLAGS)" -o release/panel-agent-mipsle-linux ./cmd/panel-agent
	CGO_ENABLED=0 GOOS=linux GOARCH=mips GOMIPS=softfloat go build -ldflags="$(LDFLAGS)" -o release/panel-agent-mips-linux ./cmd/panel-agent
	@for arch in x86_64 aarch64 armv7 mipsle mips; do \
		for variant in gnu musl; do \
			tar --owner=0 --group=0 --numeric-owner -czf release/telemt-panel-$$arch-linux-$$variant.tar.gz -C release/.stage/$$arch telemt-panel; \
		done; \
	done
	@rm -rf release/.stage
	cd release && for f in *.tar.gz; do sha256sum "$$f" > "$$f.sha256"; done
	@echo "Release assets in ./release/"

clean:
	rm -rf telemt-panel release/
