VERSION ?= 0.0.0-dev
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: build test lint release clean mock

build:
	CGO_ENABLED=0 go build -ldflags="$(LDFLAGS)" -o telemt-panel ./cmd/panel

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
# The || guard propagates gofmt's own failure (e.g. an unparseable file),
# which exits non-zero with nothing on stdout.
lint:
	@out="$$(gofmt -l .)" || { echo "gofmt failed"; exit 1; }; \
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
release:
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
