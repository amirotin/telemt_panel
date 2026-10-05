#!/bin/sh
set -eu

PRODUCT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CHECK_TMP=$(mktemp -d "${TMPDIR:-/tmp}/telemt-panel-static.XXXXXX")
trap 'rm -rf "$CHECK_TMP"' EXIT HUP INT TERM

# Never trust a previously installed binary's compiler or analyzer version.
go version >&2
mode=${1:-staticcheck}
check_tools="staticcheck deadcode govulncheck"
if [ "$mode" = size ]; then check_tools=whydeadcode; fi
for tool in $check_tools; do
    case "$tool" in
        staticcheck) package=honnef.co/go/tools/cmd/staticcheck ;;
        deadcode) package=golang.org/x/tools/cmd/deadcode ;;
        govulncheck) package=golang.org/x/vuln/cmd/govulncheck ;;
        whydeadcode) package=github.com/aarzilli/whydeadcode ;;
    esac
    (cd "$PRODUCT_ROOT/tools" && go build -mod=readonly -o "$CHECK_TMP/$tool" "$package")
    go version -m "$CHECK_TMP/$tool" >&2
done
if [ "$mode" = size ]; then
    cd "$PRODUCT_ROOT"
    for arch in amd64 arm64; do
        for profile in full lite; do
            tags=""; experiment=""
            if [ "$profile" = lite ]; then tags=lite; experiment=nojsonv2; fi
            # Keep build and analyzer statuses separate; never hide build errors in a pipe.
            CGO_ENABLED=0 GOOS=linux GOARCH=$arch GOAMD64=v1 GOEXPERIMENT=$experiment \
                go build -tags "$tags" -ldflags=-dumpdep -o /dev/null ./cmd/panel > "$CHECK_TMP/deps" 2>&1 || {
                    cat "$CHECK_TMP/deps" >&2
                    exit 1
                }
            sh "$PRODUCT_ROOT/scripts/check-size-dce.sh" "$CHECK_TMP/whydeadcode" "$CHECK_TMP/deps"
            echo "DCE: $profile/$arch OK"
        done
    done
    exit 0
fi
"$CHECK_TMP/staticcheck" -version >&2

mkdir "$CHECK_TMP/fixture"
cat > "$CHECK_TMP/fixture/go.mod" <<'EOF'
module staticcheck-go127-fixture

go 1.27
EOF
cat > "$CHECK_TMP/fixture/main.go" <<'EOF'
package main

import "fmt"

type fixture struct{}

func (fixture) identity[T any](value T) T { return value }

func main() { fmt.Println(fixture{}.identity("Go 1.27 generic-method analysis fixture")) }
EOF
(cd "$CHECK_TMP/fixture" && "$CHECK_TMP/staticcheck" ./...)

cd "$PRODUCT_ROOT"
case "${1:-staticcheck}" in
    staticcheck)
        "$CHECK_TMP/staticcheck" ./...
        GOEXPERIMENT=nojsonv2 "$CHECK_TMP/staticcheck" -tags lite ./...
        ;;
    deadcode)
        # Tests are reachable roots; cmd/telemt-mock is a deliberate developer entry.
        "$CHECK_TMP/deadcode" -test -json ./cmd/... ./internal/...
        ;;
    vuln)
        "$CHECK_TMP/govulncheck" -show verbose ./...
        GOEXPERIMENT=nojsonv2 "$CHECK_TMP/govulncheck" -show verbose -tags lite ./...
        ;;
    *) echo "usage: $0 [staticcheck|deadcode|vuln|size]" >&2; exit 2 ;;
esac
