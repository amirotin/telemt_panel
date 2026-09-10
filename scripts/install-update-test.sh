#!/bin/sh
# Isolated transaction tests: no host services, users, firewall or network.
# shellcheck disable=SC2034,SC2317
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM
REAL_INSTALL=$(command -v install)
export REAL_INSTALL
for scenario in success archived-settings fail rollback-fail copy-fail old-candidate fifo-config dry no-start; do
  dir="$TMP/$scenario"
  mkdir -p "$dir/bin" "$dir/tools"
  printf 'original binary\n' >"$dir/bin/telemt-panel"
  chmod 0751 "$dir/bin/telemt-panel"
  printf 'private-config-value\n' >"$dir/config.toml"
  if [ "$scenario" = fifo-config ]; then rm "$dir/config.toml"; mkfifo "$dir/config.toml"; fi
  printf 'ExecStart=%s --config %s\n' "$dir/bin/telemt-panel" "$dir/config.toml" >"$dir/service"
  printf '{"panel_binary_path":"%s","panel_service":"testpanel","store_driver":"memory","listen":"127.0.0.1:8080","tls_mode":"http"}\n' "$dir/bin/telemt-panel" >"$dir/report.json"
  if [ "$scenario" = archived-settings ]; then
    printf '{"panel_binary_path":"%s","panel_service":"testpanel","store_driver":"memory","listen":"127.0.0.1:8080","tls_mode":"http","warnings":["user_defaults_not_applied","release_limits_not_applied"]}\n' "$dir/bin/telemt-panel" >"$dir/report.json"
  fi
  cat >"$dir/candidate" <<'EOF'
#!/bin/sh
if [ "$TEST_SCENARIO" = old-candidate ]; then
  if [ -f config.toml ]; then printf 'unexpected startup\n' >"$TEST_DIR/unintended-start"; fi
  exit 1
fi
case "$1 $2" in
  "version ") printf 'telemt-panel 1.0.0 (full: memory)\n' ;;
  "config inspect") cat "$TEST_DIR/report.json" ;;
  "tls fingerprint") printf '%064d\n' 0 ;;
  "tls check")
    case "$*" in
      *--expect-fingerprint*) [ "$TEST_SCENARIO" != rollback-fail ] ;;
      *) [ "$TEST_SCENARIO" != fail ] && [ "$TEST_SCENARIO" != rollback-fail ] ;;
    esac ;;
  *) exit 1 ;;
esac
EOF
  cat >"$dir/tools/systemctl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$TEST_DIR/service-calls"
EOF
  cat >"$dir/tools/install" <<'EOF'
#!/bin/sh
[ "$TEST_SCENARIO" != copy-fail ] || exit 1
exec "$REAL_INSTALL" "$@"
EOF
  chmod 0755 "$dir/candidate" "$dir/tools/systemctl" "$dir/tools/install"
  export TEST_DIR="$dir" TEST_SCENARIO="$scenario"
  if (
    # shellcheck disable=SC2034
    TP_SOURCED=1
    # shellcheck disable=SC1091
    . "$HERE/../install.sh"
    cd "$TEST_DIR"
    # shellcheck disable=SC2034
    L=en; COLOR=0; C_DIM=""; C_RESET=""; C_GREEN=""; C_YELLOW=""; C_RED=""
    # shellcheck disable=SC2034
    INIT=systemd; BUILD_VARIANT=full; ASSUME_YES=1; SUDO=""
    CONFIG_FILE="$TEST_DIR/config.toml"; BINARY_FILE="$TEST_DIR/candidate"
    PATH="$TEST_DIR/tools:$PATH"
    case "$TEST_SCENARIO" in dry) DRY_RUN=1 ;; no-start) NO_START=1 ;; esac
    apply_layout_from_answers() { BIN_DIR="$TEST_DIR/bin"; SERVICE_FILE="$TEST_DIR/service"; }
    configure_firewall() { exit 91; }
    create_user() { exit 92; }
    install_service() { exit 93; }
    install_sudoers() { exit 94; }
    do_update_existing
  ) >"$dir/output" 2>&1; then result=0; else result=$?; fi
  case "$scenario" in
    fail|rollback-fail|copy-fail|old-candidate|fifo-config)
      [ "$result" != 0 ] || { cat "$dir/output"; exit 1; }
      [ "$(cat "$dir/bin/telemt-panel")" = "original binary" ]
      [ "$(stat -c %a "$dir/bin/telemt-panel")" = 751 ]
      case "$scenario" in
        fail|copy-fail) grep -q 'Previous panel response restored' "$dir/output" ;;
        rollback-fail) grep -q 'Automatic recovery failed' "$dir/output" ;;
        old-candidate|fifo-config) [ ! -e "$dir/unintended-start" ] && [ ! -e "$dir/service-calls" ] ;;
      esac ;;
    dry)
      [ "$result" = 0 ] || { cat "$dir/output"; exit 1; }
      [ "$(cat "$dir/bin/telemt-panel")" = "original binary" ]
      [ ! -e "$dir/service-calls" ]
      [ "$(find "$dir/bin" -name '.telemt-panel-backup.*' | wc -l)" = 0 ] ;;
    *)
      [ "$result" = 0 ] || { cat "$dir/output"; exit 1; }
      cmp "$dir/candidate" "$dir/bin/telemt-panel"
      [ "$(stat -c %a "$dir/bin/telemt-panel")" = 755 ]
      if [ "$scenario" = no-start ]; then [ ! -e "$dir/service-calls" ]; fi ;;
  esac
  if [ "$scenario" = fifo-config ]; then
    [ -p "$dir/config.toml" ]
  else
    [ "$(cat "$dir/config.toml")" = private-config-value ]
  fi
  if grep -q private-config-value "$dir/output"; then exit 1; fi
  if [ "$scenario" = archived-settings ]; then
    grep -q 'Old values are archived in panel state' "$dir/output"
  fi
  [ "$(find "$dir/bin" -name '.telemt-panel-new.*' -o -name '.telemt-panel-restore.*' | wc -l)" = 0 ]
  printf 'PASS installer transaction %s\n' "$scenario"
done

# Validate archive members without extracting paths or following links.
printf 'unchanged\n' >"$TMP/outside"
for scenario in valid symlink extra; do
  dir="$TMP/archive-$scenario"
  mkdir -p "$dir/payload"
  if [ "$scenario" = symlink ]; then
    ln -s "$TMP/outside" "$dir/payload/telemt-panel"
  else
    printf 'candidate bytes\n' >"$dir/payload/telemt-panel"
  fi
  if [ "$scenario" = extra ]; then
    printf 'extra\n' >"$dir/payload/extra"
    tar -czf "$dir/archive.tar.gz" -C "$dir/payload" telemt-panel extra
  else
    tar -czf "$dir/archive.tar.gz" -C "$dir/payload" telemt-panel
  fi
  sha256sum "$dir/archive.tar.gz" >"$dir/archive.sha256"
  if (
    TP_SOURCED=1
    # shellcheck disable=SC1091
    . "$HERE/../install.sh"
    L=en; COLOR=0; setup_colors
    BUILD_VARIANT=full; ARCH=x86_64; LIBC=gnu
    resolve_tag() { INSTALLED_TAG=v1.0.0; }
    download() {
      case "$1" in
        *.sha256) cp "$dir/archive.sha256" "$2" ;;
        *) cp "$dir/archive.tar.gz" "$2" ;;
      esac
    }
    fetch_release
    [ "$(cat "$STAGED_BIN")" = "candidate bytes" ]
  ) >"$dir/output" 2>&1; then result=0; else result=$?; fi
  if [ "$scenario" = valid ]; then
    [ "$result" = 0 ] || { cat "$dir/output"; exit 1; }
  else
    [ "$result" != 0 ] || exit 1
  fi
  [ "$(cat "$TMP/outside")" = unchanged ]
  printf 'PASS archive %s\n' "$scenario"
done
