#!/bin/sh
# All destructive targets are under mktemp; service control is stubbed.
# shellcheck disable=SC2034,SC2317,SC2329
set -eu
umask 022
HERE=$(cd "$(dirname "$0")" && pwd)
PARSER="${TP_TEST_BINARY:-$HERE/../telemt-panel}"
if [ ! -x "$PARSER" ]; then echo "SKIP removal fixtures: set TP_TEST_BINARY"; exit 0; fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM
HASH=$(printf 'fixture-password\n' | "$PARSER" hash-password)
for scenario in uninstall retained-purge interrupted-purge replaced-binary unsafe-receipt unsafe-service purge remote-telemt external-config legacy unsafe overlap binary-overlap symlink stop-fails service-mismatch changed dry after-uninstall worker-data worker-unbound-data worker-retained-data worker-unregistered-retry worker-partial-launcher worker-partial-updater worker-partial-purge worker-partial-replaced; do
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
    worker-unbound-data) TARGET_DATA="$CASE/external" ;;
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
  case "$scenario" in worker-*)
    printf "updates.worker_state_dir='%s/config/updater'\n" "$CASE" >>"$CASE/config/config.toml"
    printf 'ReadWritePaths=%s/config %s/data\n' "$CASE" "$CASE" >>"$CASE/unit"
    mkdir "$CASE/config/updater" ;;
  esac
  if [ "$scenario" = external-config ]; then
    mkdir "$CASE/config/updater"
    printf "updates.worker_state_dir='%s/config/updater'\n" "$CASE" >>"$CASE/config/config.toml"
    mv "$CASE/config/config.toml" "$CASE/external/panel.toml"
    printf 'operator-owned\n' >"$CASE/config/keep-me"
    printf 'ExecStart=%s --config %s\n' "$CASE/bin/panel" "$CASE/external/panel.toml" >"$CASE/unit"
  fi
  case "$scenario" in
    service-mismatch) printf 'other service\n' >"$CASE/unit" ;;
    unsafe-receipt) ln -s "$CASE/external" "$CASE/receipt" ;;
    unsafe-service) chmod 0666 "$CASE/unit" ;;
    after-uninstall) rm "$CASE/bin/panel" "$CASE/unit" "$CASE/sudoers" ;;
  esac
  cat >"$CASE/tools/systemctl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$CASE/calls"
if [ "$SCENARIO" = stop-fails ] && [ "$1" = stop ]; then exit 1; fi
case "$SCENARIO:$1" in interrupted-purge:daemon-reload|replaced-binary:daemon-reload|worker-unregistered-retry:daemon-reload)
  if [ ! -e "$CASE/failed" ]; then : >"$CASE/failed"; exit 1; fi ;;
esac
case "$SCENARIO:$*" in
  worker-*:'show --property=FragmentPath --value '*) echo "$CASE/unit" ;;
  worker-*:'show --property=DynamicUser --value '*) echo no ;;
  worker-*:'show --property=User --value '*) id -un ;;
esac
EOF
  chmod 0755 "$CASE/tools/systemctl"
  case "$scenario" in worker-partial-*)
    REAL_RM=$(command -v rm); export REAL_RM
    cat >"$CASE/tools/rm" <<'EOF'
#!/bin/sh
if [ ! -e "$CASE/failed" ]; then
  for target do
    case "$SCENARIO:$target" in
      worker-partial-launcher:"$CASE/bin/panel.start"|worker-partial-updater:"$CASE/custom-panel-updater.service"|worker-partial-purge:"$CASE/custom-panel-updater.service"|worker-partial-replaced:"$CASE/custom-panel-updater.service")
        : >"$CASE/failed"
        for other do
          case "$other" in "$CASE/bin/panel.start"|"$CASE/custom-panel-updater.service")
            [ "$other" = "$target" ] || "$REAL_RM" -f "$other" ;;
          esac
        done
        exit 1 ;;
    esac
  done
fi
exec "$REAL_RM" "$@"
EOF
    chmod 0755 "$CASE/tools/rm" ;;
  esac
  # Model namespace uid 0 for this unprivileged fixture. All modes and all
  # other ownership queries come from the filesystem.
  REAL_STAT=$(command -v stat)
  export REAL_STAT
  cat >"$CASE/tools/stat" <<'EOF'
#!/bin/sh
if [ "$1" = -c ] && [ "$2" = %u ]; then
  case "$SCENARIO:$3" in worker-*:"$CASE/config"|worker-*:"$CASE/config/config.toml") echo 65534; exit 0 ;; esac
  case "$3" in /|/tmp) echo 0; exit 0 ;; esac
  if [ "$("$REAL_STAT" "$@")" = "$(id -u)" ]; then echo 0; exit 0; fi
fi
exec "$REAL_STAT" "$@"
EOF
  chmod 0755 "$CASE/tools/stat"
  export CASE SCENARIO="$scenario"
  if (
    TP_SOURCED=1
    # shellcheck disable=SC1091
    . "$HERE/../install.sh"
    L=en; COLOR=0; setup_colors
    CMD=purge
    case "$SCENARIO" in uninstall|retained-purge|interrupted-purge|replaced-binary|unsafe-receipt|unsafe-service|binary-overlap|worker-retained-data|worker-unregistered-retry|worker-partial-*) CMD=uninstall ;; esac
    CONFIG_DIR="$CASE/config"; CONFIG_FILE="$CONFIG_DIR/config.toml"
    SUDOERS_FILE="$CASE/sudoers"; TELEMT_CONFIG="$CASE/telemt/telemt.toml"
    REINSTALL_DIR="$CASE/receipt"
    if [ "$SCENARIO" = remote-telemt ]; then TELEMT_CONFIG="$CASE/absent/etc/telemt.toml"; fi
    if [ "$SCENARIO" = external-config ]; then CONFIG_FILE="$CASE/external/panel.toml"; fi
    BINARY_FILE="$PARSER"; ASSUME_YES=1
    if [ "$SCENARIO" = dry ]; then DRY_RUN=1; fi
    PATH="$CASE/tools:$PATH"
    require_tty() { :; }
    check_prereqs_quiet() { :; }
    detect_init() { INIT=systemd; }
    apply_layout() { PANEL_BIN="$CASE/bin/panel"; SERVICE_FILE="$CASE/unit"; DATA_DIR=/var/lib/telemt-panel; }
    apply_layout_from_answers() {
      validate_service_names
      [ "$SERVICE_NAME" = custom-panel ] || exit 1
      BIN_DIR=$(dirname "$PANEL_BIN"); SERVICE_FILE="$CASE/unit"
    }
    confirm_danger() {
      if [ "$SCENARIO" = changed ]; then printf '\n# changed\n' >>"$CONFIG_FILE"; fi
      return 0
    }
    case "$SCENARIO" in worker-*)
      INIT=systemd; RUN_AS=user; SYSTEM_USER=$(id -un); PANEL_BIN="$CASE/bin/panel"
      SERVICE_NAME=custom-panel; SERVICE_FILE="$CASE/unit"; WORKER_STATE_OVERRIDE="$CASE/config/updater"; DATA_DIR="$CASE/data"
      worker_layout; gen_panel_launcher >"$PANEL_LAUNCH_BIN"; gen_updater_service >"$WORKER_SERVICE_FILE" ;;
    esac
    case "$SCENARIO" in worker-partial-*)
      if [ "$SCENARIO" = worker-partial-purge ]; then
        if (trap installer_exit EXIT; CMD=purge; do_purge); then exit 1; fi
      elif (trap installer_exit EXIT; do_uninstall); then exit 1; fi
      [ -e "$CASE/failed" ] && [ ! -e "$CASE/unit" ] && [ -f "$CASE/receipt/stopped_binary" ] || exit 1
      if [ "$SCENARIO" = worker-partial-launcher ]; then
        [ -f "$PANEL_LAUNCH_BIN" ] && [ ! -e "$WORKER_SERVICE_FILE" ] || exit 1
        do_uninstall
      else
        [ ! -e "$PANEL_LAUNCH_BIN" ] && [ -f "$WORKER_SERVICE_FILE" ] || exit 1
        if [ "$SCENARIO" = worker-partial-replaced ]; then printf 'operator replacement\n' >"$WORKER_SERVICE_FILE"; fi
        CMD=purge; do_purge
      fi
      exit 0 ;;
    esac
    if [ "$SCENARIO" = interrupted-purge ] || [ "$SCENARIO" = replaced-binary ] || [ "$SCENARIO" = worker-unregistered-retry ]; then
      if (trap installer_exit EXIT; do_uninstall); then exit 1; fi
      [ ! -e "$CASE/unit" ] && [ -f "$CASE/bin/panel" ] || exit 1
      if [ "$SCENARIO" = replaced-binary ]; then printf 'different binary\n' >"$CASE/bin/panel"; fi
      CMD=purge; do_purge
    elif [ "$CMD" = uninstall ]; then
      do_uninstall
      case "$SCENARIO" in
        uninstall) BINARY_FILE=""; do_uninstall ;;
        retained-purge) TEMP_DIR=""; CMD=purge; do_purge ;;
        worker-retained-data)
          [ "$(cat "$REINSTALL_DIR/data_dir")" = "$CASE/data" ] || exit 1
          sed "s@^data_dir = .*@data_dir = '$CASE/external'@" "$CONFIG_FILE" >"$CASE/new.toml"
          mv "$CASE/new.toml" "$CONFIG_FILE"
          TEMP_DIR=""; CMD=purge; do_purge ;;
      esac
    else do_purge; fi
  ) >"$CASE/output" 2>&1; then result=0; else result=$?; fi
  case "$scenario" in
    unsafe|overlap|binary-overlap|symlink|stop-fails|service-mismatch|changed|unsafe-receipt|unsafe-service)
      [ "$result" != 0 ] || { cat "$CASE/output"; exit 1; }
      [ -f "$CASE/bin/panel" ] && [ -f "$CASE/unit" ] && [ -f "$CASE/data/history" ]
      if [ "$scenario" != stop-fails ]; then [ ! -e "$CASE/calls" ]; fi ;;
    external-config)
      if [ "$result" != 0 ] || [ ! -f "$CASE/config/keep-me" ] || [ -e "$CASE/external/panel.toml" ] || [ -e "$CASE/config/updater" ] || [ -e "$CASE/data" ]; then cat "$CASE/output"; exit 1; fi ;;
    dry) [ "$result" = 0 ] && [ -f "$CASE/bin/panel" ] && [ ! -e "$CASE/calls" ] ;;
    uninstall)
      if [ "$result" != 0 ] || [ -e "$CASE/bin/panel" ] || [ ! -f "$CASE/config/config.toml" ] || [ ! -f "$CASE/data/history" ] ||
        [ "$(cat "$CASE/receipt/config_path")" != "$CASE/config/config.toml" ] || [ "$(cat "$CASE/receipt/worker_protocol")" != 0 ] ||
        [ "$(cat "$CASE/receipt/service")" != "ExecStart=$CASE/bin/panel --config $CASE/config/config.toml" ] ||
        [ "$(cat "$CASE/receipt/sudoers")" != policy ] || [ "$(stat -c %a "$CASE/receipt")" != 700 ]; then cat "$CASE/output"; exit 1; fi ;;
    worker-unbound-data|worker-retained-data)
      if [ "$result" != 0 ] || [ -e "$CASE/config" ] || [ -e "$CASE/receipt" ] || [ -e "$CASE/bin/panel" ] ||
        [ ! -f "$CASE/external/cert" ] || ! grep -q 'will be retained' "$CASE/output"; then cat "$CASE/output"; exit 1; fi ;;
    worker-partial-launcher)
      if [ "$result" != 0 ] || [ -e "$CASE/bin/panel.start" ] || [ -e "$CASE/bin/panel" ] || [ ! -f "$CASE/data/history" ]; then cat "$CASE/output"; exit 1; fi ;;
    worker-partial-replaced)
      if [ "$result" = 0 ] || [ "$(cat "$CASE/custom-panel-updater.service")" != 'operator replacement' ] || [ ! -f "$CASE/data/history" ]; then cat "$CASE/output"; exit 1; fi ;;
    retained-purge|interrupted-purge|worker-unregistered-retry|worker-partial-updater|worker-partial-purge)
      if [ "$result" != 0 ] || [ -e "$CASE/receipt" ] || [ -e "$CASE/config" ] || [ -e "$CASE/data" ] ||
        [ -e "$CASE/custom-panel-updater.service" ]; then cat "$CASE/output"; exit 1; fi ;;
    replaced-binary)
      if [ "$result" = 0 ] || [ "$(cat "$CASE/bin/panel")" != 'different binary' ] || [ ! -d "$CASE/receipt" ] || [ ! -f "$CASE/data/history" ]; then cat "$CASE/output"; exit 1; fi ;;
    *) if [ "$result" != 0 ] || [ -e "$CASE/config" ] || [ -e "$CASE/data" ]; then cat "$CASE/output"; exit 1; fi ;;
  esac
  [ -f "$CASE/telemt/telemt" ] && [ -f "$CASE/telemt/telemt.toml" ] && [ -f "$CASE/external/cert" ] && [ -f "$CASE/bin/panel.bak" ]
  if grep -q PRIVATE_JWT "$CASE/output"; then exit 1; fi
  printf 'PASS removal %s\n' "$scenario"
done
