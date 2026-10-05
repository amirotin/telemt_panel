#!/bin/sh
set -eu
if [ "$#" -ne 2 ]; then echo "usage: check-size-dce.sh <whydeadcode> <linker-output>" >&2; exit 2; fi
clean=$(mktemp "${TMPDIR:-/tmp}/panel-dce.XXXXXX")
trap 'rm -f "$clean"' EXIT HUP INT TERM
# The pinned analyzer tolerates one unknown line. Validate all input first.
awk '
    /^# [^ ]+$/ { next }
    / -> / { count++; print; next }
    { print "unrecognized linker output: " $0 > "/dev/stderr"; exit 1 }
    END { if (count == 0) { print "empty linker dependency graph" > "/dev/stderr"; exit 1 } }
' "$2" > "$clean"
"$1" -fail < "$clean"
