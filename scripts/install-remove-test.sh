#!/bin/sh
# All destructive targets are under mktemp; service control is stubbed.
# shellcheck disable=SC2034,SC2317
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
PARSER="${TP_TEST_BINARY:-$HERE/../telemt-panel}"
if [ ! -x "$PARSER" ]; then echo "SKIP removal fixtures: set TP_TEST_BINARY"; exit 0; fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM
HASH=$(printf 'fixture-password\n' | "$PARSER" hash-password)
for scenario in uninstall purge legacy unsafe overlap binary-overlap symlink stop-fails service-mismatch changed dry after-uninstall; do
  CASE="$TMP/$scenario"
  mkdir -p "$CASE/config" "$CASE/data" "$CASE/bin" "$CASE/telemt" "$CASE/tools" "$CASE/external"
  printf 'panel binary\n' >"$CASE/bin/panel"
  printf 'backup\n' >"$CASE/bin/panel.bak"
  printf 'telemt\n' >"$CASE/telemt/telemt"
  printf 'config\n' >"$CASE/telemt/telemt.toml"
  printf 'external\n' >"$CASE/external/cert"
  printf 'history\n' >"$CASE/data/history"
  printf 'policy\n' >"$CASE/sudoers"
  TARGET_DATA="$CASE/data"
  TARGET_BIN="$CASE/bin/panel"
  case "$scenario" in
    unsafe) TARGET_DATA=/ ;;
    overlap) TARGET_DATA="$CASE/telemt" ;;
    binary-overlap) TARGET_BIN="$CASE/config/config.toml" ;;
    symlink) ln -s "$CASE/external" "$CASE/link"; TARGET_DATA="$CASE/link" ;;
  esac
  printf "data_dir = '%s'\nauth.username='admin'\nauth.password_hash='%s'\ntelemt.url='http://127.0.0.1:1'\n" "$TARGET_DATA" "$HASH" >"$CASE/config/config.toml"
  if [ "$scenario" = legacy ]; then
    printf "auth.jwt_secret='PRIVATE_JWT'\npanel.binary_path='%s'\npanel.service_name='custom-panel'\ntelemt.binary_path='%s'\n" "$CASE/bin/panel" "$CASE/telemt/telemt" >>"$CASE/config/config.toml"
  else
    printf "updates.panel_binary_path='%s'\nupdates.telemt_binary_path='%s'\nhost.panel_service='custom-panel'\n" "$TARGET_BIN" "$CASE/telemt/telemt" >>"$CASE/config/config.toml"
  fi
  printf 'ExecStart=%s --config %s\n' "$CASE/bin/panel" "$CASE/config/config.toml" >"$CASE/unit"
  case "$scenario" in
    service-mismatch) printf 'other service\n' >"$CASE/unit" ;;
    after-uninstall) rm "$CASE/bin/panel" "$CASE/unit" "$CASE/sudoers" ;;
  esac
  cat >"$CASE/tools/systemctl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$CASE/calls"
if [ "$SCENARIO" = stop-fails ] && [ "$1" = stop ]; then exit 1; fi
EOF
  chmod 0755 "$CASE/tools/systemctl"
  export CASE SCENARIO="$scenario"
  if (
    TP_SOURCED=1
    # shellcheck disable=SC1091
    . "$HERE/../install.sh"
    L=en; COLOR=0; setup_colors
    CMD=purge
    case "$SCENARIO" in uninstall|binary-overlap) CMD=uninstall ;; esac
    CONFIG_DIR="$CASE/config"; CONFIG_FILE="$CONFIG_DIR/config.toml"
    SUDOERS_FILE="$CASE/sudoers"; TELEMT_CONFIG="$CASE/telemt/telemt.toml"
    BINARY_FILE="$PARSER"; ASSUME_YES=1
    if [ "$SCENARIO" = dry ]; then DRY_RUN=1; fi
    PATH="$CASE/tools:$PATH"
    require_tty() { :; }
    check_prereqs_quiet() { :; }
    detect_init() { INIT=systemd; }
    apply_layout() { PANEL_BIN="$CASE/bin/panel"; SERVICE_FILE="$CASE/unit"; }
    apply_layout_from_answers() {
      validate_service_names
      [ "$SERVICE_NAME" = custom-panel ] || exit 1
      BIN_DIR=$(dirname "$PANEL_BIN"); SERVICE_FILE="$CASE/unit"
    }
    confirm_danger() {
      if [ "$SCENARIO" = changed ]; then printf '\n# changed\n' >>"$CONFIG_FILE"; fi
      return 0
    }
    if [ "$CMD" = uninstall ]; then do_uninstall; else do_purge; fi
  ) >"$CASE/output" 2>&1; then result=0; else result=$?; fi
  case "$scenario" in
    unsafe|overlap|binary-overlap|symlink|stop-fails|service-mismatch|changed)
      [ "$result" != 0 ] || { cat "$CASE/output"; exit 1; }
      [ -f "$CASE/bin/panel" ] && [ -f "$CASE/unit" ] && [ -f "$CASE/data/history" ]
      if [ "$scenario" != stop-fails ]; then [ ! -e "$CASE/calls" ]; fi ;;
    dry) [ "$result" = 0 ] && [ -f "$CASE/bin/panel" ] && [ ! -e "$CASE/calls" ] ;;
    uninstall) [ "$result" = 0 ] && [ ! -e "$CASE/bin/panel" ] && [ -f "$CASE/config/config.toml" ] && [ -f "$CASE/data/history" ] ;;
    *) if [ "$result" != 0 ] || [ -e "$CASE/config" ] || [ -e "$CASE/data" ]; then cat "$CASE/output"; exit 1; fi ;;
  esac
  [ -f "$CASE/telemt/telemt" ] && [ -f "$CASE/telemt/telemt.toml" ] && [ -f "$CASE/external/cert" ] && [ -f "$CASE/bin/panel.bak" ]
  if grep -q PRIVATE_JWT "$CASE/output"; then exit 1; fi
  printf 'PASS removal %s\n' "$scenario"
done
