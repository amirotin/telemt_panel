VERSION ?= 0.0.0-dev
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: build test lint release clean

build:
	CGO_ENABLED=0 go build -ldflags="$(LDFLAGS)" -o telemt-panel ./cmd/panel

# -race matches CI; it needs cgo (a C toolchain), unlike the pure-Go
# CGO_ENABLED=0 release builds.
test:
	go test -race ./...

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

# Static binaries for every supported target, router SoCs included.
# Asset names keep the telemt-panel-<arch>-linux prefix the 0.x updater matches.
release:
	@mkdir -p release
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -o release/telemt-panel-x86_64-linux ./cmd/panel
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="$(LDFLAGS)" -o release/telemt-panel-aarch64-linux ./cmd/panel
	CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 go build -ldflags="$(LDFLAGS)" -o release/telemt-panel-armv7-linux ./cmd/panel
	CGO_ENABLED=0 GOOS=linux GOARCH=mipsle GOMIPS=softfloat go build -ldflags="$(LDFLAGS)" -o release/telemt-panel-mipsle-linux ./cmd/panel
	CGO_ENABLED=0 GOOS=linux GOARCH=mips GOMIPS=softfloat go build -ldflags="$(LDFLAGS)" -o release/telemt-panel-mips-linux ./cmd/panel
	cd release && for bin in telemt-panel-*; do sha256sum "$$bin" > "$$bin.sha256"; done
	@echo "Binaries in ./release/"

clean:
	rm -rf telemt-panel release/
