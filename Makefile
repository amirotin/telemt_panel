# Use the Go minor declared in root go.mod (latest patch) and Node 22.
# web/go.mod only isolates frontend dependencies from Go package traversal.
VERSION ?= 0.0.0-dev
LDFLAGS := -s -w -X main.version=$(VERSION)
# Go 1.27's classic encoding/json implementation keeps lite within 16 MiB.
# Full SQLite requires json/v2. Keep this limited to lite and its CI checks;
# revisit when Go removes the documented nojsonv2 compatibility opt-out.
LITE_GOEXPERIMENT := nojsonv2
RELEASE_CHECK_SIZE ?= 1

.PHONY: build build-lite test test-race lint release release-size clean mock web dev-frontend dev-backend

# Builds the SPA straight into internal/webui/dist (web/vite.config.ts's
# outDir) — the package's go:embed directive picks it up with no
# copy/symlink step. `build` and `release` depend on this so `go:embed`
# never sees a stale or placeholder-only dist/ (the v0 lesson: frontend
# before backend, always — see internal/webui/embed.go).
web:
	cd web && npm ci && npm run build

build: web
	CGO_ENABLED=0 go build -ldflags="$(LDFLAGS)" -o telemt-panel ./cmd/panel

build-lite: web
	CGO_ENABLED=0 GOEXPERIMENT=$(LITE_GOEXPERIMENT) go build -tags lite -ldflags="$(LDFLAGS)" -o telemt-panel-lite ./cmd/panel

# Frontend dev server (vite) — proxies /api and /sub to dev-backend below.
dev-frontend:
	cd web && npm run dev

# Panel against config.toml (copy config.example.toml; point [telemt].url
# at `make mock`'s :9091 for a frontend-only dev loop with no real Telemt).
# Serves whatever is currently in internal/webui/dist — run `make web`
# first, or just use dev-frontend for frontend work instead.
dev-backend:
	go run ./cmd/panel --config config.toml

# Fast checks on pushes and PRs; race runs separately and before publication.
test:
	go test ./...

# The race detector requires cgo and a C toolchain, unlike release binaries.
# Rerun tests even when a previous successful result is cached.
test-race:
	go test -race -count=1 ./...

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

# Static binaries for Telemt's supported x86_64/aarch64 hosts, packaged
# for internal/update's AssetMatcher (+ <asset>.sha256, one file named
# telemt-panel per tarball). Full contains every store driver; lite contains
# only memory. Both are pure-Go static binaries, so the transitional 1.0
# gnu/musl tarballs carry identical content for each build profile while
# preserving the 0.x-updater-compatible names from migration spec 08.
# Clear stale output even when the frontend fails, then build it exactly once
# ahead of every per-arch binary (they all embed the same internal/webui/dist).
release:
	@rm -rf release
	$(MAKE) web
	@for path in full/x86_64 full/aarch64 lite/x86_64 lite/aarch64; do mkdir -p "release/.stage/$$path"; done
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOAMD64=v1 go build -trimpath -ldflags="$(LDFLAGS)" -o release/.stage/full/x86_64/telemt-panel ./cmd/panel
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="$(LDFLAGS)" -o release/.stage/full/aarch64/telemt-panel ./cmd/panel
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOAMD64=v1 GOEXPERIMENT=$(LITE_GOEXPERIMENT) go build -trimpath -tags lite -ldflags="$(LDFLAGS)" -o release/.stage/lite/x86_64/telemt-panel ./cmd/panel
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 GOEXPERIMENT=$(LITE_GOEXPERIMENT) go build -trimpath -tags lite -ldflags="$(LDFLAGS)" -o release/.stage/lite/aarch64/telemt-panel ./cmd/panel
	@case "$(RELEASE_CHECK_SIZE)" in \
		1) $(MAKE) release-size ;; \
		0) $(MAKE) release-size || echo "WARNING: size enforcement deferred for this qualification build" ;; \
		*) echo "RELEASE_CHECK_SIZE must be 0 or 1"; exit 2 ;; \
	esac
	@set -eu; for arch in x86_64 aarch64; do \
		for variant in gnu musl; do \
			tar --owner=0 --group=0 --numeric-owner -czf release/telemt-panel-$$arch-linux-$$variant.tar.gz -C release/.stage/full/$$arch telemt-panel; \
		done; \
	done
	@set -eu; for arch in x86_64 aarch64; do \
		for variant in gnu musl; do \
			tar --owner=0 --group=0 --numeric-owner -czf release/telemt-panel-lite-$$arch-linux-$$variant.tar.gz -C release/.stage/lite/$$arch telemt-panel; \
		done; \
	done
	@rm -rf release/.stage
	@set -eu; cd release; for f in *.tar.gz; do sha256sum "$$f" > "$$f.sha256"; done
	@echo "Release assets in ./release/"

release-size:
	@set -eu; failed=0; for profile in full lite; do \
		limit=33554432; if [ "$$profile" = lite ]; then limit=16777216; fi; \
		for arch in x86_64 aarch64; do \
			file="release/.stage/$$profile/$$arch/telemt-panel"; \
			if [ ! -f "$$file" ]; then echo "missing binary: $$file"; failed=1; continue; fi; \
			bytes=$$(wc -c < "$$file"); \
			echo "$$profile/$$arch: $$bytes bytes (limit $$limit)"; \
			if [ "$$bytes" -gt "$$limit" ]; then echo "$$profile binary exceeds size budget: $$file"; failed=1; fi; \
		done; \
	done; exit "$$failed"

clean:
	rm -rf telemt-panel telemt-panel-lite release/
