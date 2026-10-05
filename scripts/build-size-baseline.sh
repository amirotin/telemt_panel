#!/bin/sh
set -eu
if [ "$#" -ne 2 ]; then echo "usage: build-size-baseline.sh <base-sha> <output.json>" >&2; exit 2; fi
base_sha=$1
output=$2
case "$base_sha" in *[!0-9a-f]*|'') echo "invalid baseline SHA" >&2; exit 2 ;; esac
product_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
size_go_dir=$(cd "$product_root" && go env GOROOT)/bin
base_dir=$(mktemp -d "${TMPDIR:-/tmp}/panel-size-base.XXXXXX")
trap 'rm -rf "$base_dir"' EXIT HUP INT TERM
git -C "$product_root" archive -o "$base_dir/source.tar" "$base_sha"
tar -xf "$base_dir/source.tar" -C "$base_dir"
# Historical revisions use exactly the head release flags, not their own old recipes.
cp "$product_root/Makefile" "$base_dir/size.Makefile"
(cd "$base_dir/web" && npm ci && npm run build)
(cd "$base_dir" && PATH="$size_go_dir:$PATH" GOFLAGS="${GOFLAGS:-} -buildvcs=false" GOTOOLCHAIN=local \
    make -f size.Makefile release-binaries VERSION=0.0.0-dev)
SIZE_REVISION=$base_sha SIZE_BUILD_VERSION=0.0.0-dev GITHUB_STEP_SUMMARY= \
    node "$product_root/scripts/report-binary-size.mjs" "$base_dir/release/.stage" "$base_dir/internal/webui/dist" > "$output"
