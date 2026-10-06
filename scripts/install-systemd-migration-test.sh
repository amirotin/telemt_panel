#!/bin/sh
# Transaction fixtures use the published config parser without host mutations.
# Fixture callbacks and globals are consumed by the sourced installer.
# shellcheck disable=SC2034,SC2317,SC1090
set -eu
HERE=$(CDPATH="" cd -- "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM
CANDIDATE="${TP_TEST_BINARY:-$HERE/../telemt-panel}"
[ -x "$CANDIDATE" ] || { printf 'Set TP_TEST_BINARY to an executable panel binary for systemd migration tests.\n' >&2; exit 1; }
for scenario in user root root-sudo root-mismatched-policy root-sudo-mismatched-policy dry no-start manual direct inline-manual inline-direct sudoers-symlink sudoers-directory writable-ancestor nonroot-ancestor legacy-denied matching-policy mismatched-policy policy-fail restart-fail; do
  WORK="$TMP/$scenario"
  mkdir -p "$WORK/bin" "$WORK/config" "$WORK/data" "$WORK/protected" "$WORK/libexec" "$WORK/sudoers"
  chmod 0700 "$WORK/protected"
  FIXTURE_HELPER_DIR="$WORK/libexec"
  case "$scenario" in writable-ancestor|nonroot-ancestor)
    FIXTURE_HELPER_DIR="$WORK/unsafe/libexec"; mkdir -p "$FIXTURE_HELPER_DIR"
    if [ "$scenario" = writable-ancestor ]; then chmod 0777 "$WORK/unsafe"; fi ;;
  esac
  printf original-binary >"$WORK/bin/panel"; chmod 0751 "$WORK/bin/panel"
  printf old-sudoers >"$WORK/sudoers/panel"
  case "$scenario" in
    sudoers-symlink) mv "$WORK/sudoers/panel" "$WORK/sudoers/untouched"; ln -s "$WORK/sudoers/untouched" "$WORK/sudoers/panel" ;;
    sudoers-directory) rm "$WORK/sudoers/panel"; mkdir "$WORK/sudoers/panel" ;;
  esac
  case "$scenario" in matching-policy|mismatched-policy|root-mismatched-policy|root-sudo-mismatched-policy) printf other-instance-policy >"$WORK/protected/policy.json"; printf other-instance-helper >"$WORK/libexec/helper" ;; esac
  cat >"$WORK/config/config.toml" <<EOF
listen = "127.0.0.1:48280"
data_dir = "$WORK/data"
[telemt]
url = "http://127.0.0.1:9091"
[auth]
disabled = true
[updates]
telemt_binary_path = "/bin/telemt"
panel_binary_path = "$WORK/bin/panel"
[host]
service_manager = "systemd"
[privileges]
helper_path = "$FIXTURE_HELPER_DIR/helper"
policy_path = "$WORK/protected/policy.json"
EOF
  case "$scenario" in manual|direct) printf 'mode = "%s"\n' "$scenario" >>"$WORK/config/config.toml" ;; esac
  case "$scenario" in root-sudo|root-sudo-mismatched-policy) printf 'mode = "sudo"\n' >>"$WORK/config/config.toml" ;; esac
  case "$scenario" in inline-manual|inline-direct)
    awk -v mode="${scenario#inline-}" -v helper="$WORK/libexec/helper" -v policy="$WORK/protected/policy.json" '
      BEGIN {print "privileges = { mode = \"" mode "\", helper_path = \"" helper "\", policy_path = \"" policy "\" }"}
      /^\[privileges\]/ || /^helper_path =/ || /^policy_path =/ {next}
      {print}
    ' "$WORK/config/config.toml" >"$WORK/current"
    mv "$WORK/current" "$WORK/config/config.toml" ;;
  esac
  if [ "$scenario" = matching-policy ]; then
    awk '/^telemt_binary_path =/ {print "telemt_binary_path = \"/usr/bin/telemt\"\ngithub_token = \047\047\047secret\n[updates]\n\047\047\047"; next} {print}' "$WORK/config/config.toml" >"$WORK/current"
    mv "$WORK/current" "$WORK/config/config.toml"
  fi
  chmod 0640 "$WORK/config/config.toml"; cp -p "$WORK/config/config.toml" "$WORK/original.toml"
  printf 'ExecStart=%s --config %s\n' "$WORK/bin/panel" "$WORK/config/config.toml" >"$WORK/service"
  if (
    TP_SOURCED=1
    . "${TP_TEST_INSTALLER:-$HERE/../install.sh}"
    L=en; COLOR=0; setup_colors; INIT=systemd; ASSUME_YES=1; BUILD_VARIANT=full
    BINARY_FILE="$CANDIDATE"; CONFIG_DIR="$WORK/config"; CONFIG_FILE="$CONFIG_DIR/config.toml"
    SUDO=fixture_root; SUDOERS_FILE="$WORK/sudoers/panel"
    apply_layout_from_answers() { BIN_DIR="$WORK/bin"; SERVICE_FILE="$WORK/service"; }
    systemctl() {
      case "$*" in
        'show --property=FragmentPath --value '*) printf '%s\n' "$WORK/service" ;;
        'show --property=DynamicUser --value '*) printf no ;;
        'show --property=User --value '*) case "$scenario" in root|root-*) printf 0 ;; *) printf 65534 ;; esac ;;
        *) printf '%s\n' "$*" >>"$WORK/calls" ;;
      esac
    }
    fixture_root() {
      if [ "$*" = 'sudo -n -ll -U nobody' ]; then
        printf 'Sudoers entry:\n    RunAsUsers: root\n    Options: !authenticate\n    Commands:\n        /usr/bin/cp\n'
        return
      fi
      if [ "$1" = sudo ]; then [ "$scenario" != legacy-denied ]; return; fi
      if [ "$1" = stat ] && [ "$2" = -c ] && [ "$3" = %u ]; then
        if [ "$scenario" = nonroot-ancestor ] && [ "$4" = "$WORK/unsafe" ]; then printf '1001\n'; else printf '0\n'; fi
        return
      fi
      if [ "${2:-}" = tls ]; then
        case "$3" in fingerprint) printf '%064d\n' 0 ;; check) : ;; esac
        return
      fi
      if [ "$scenario" = matching-policy ] && [ "${4:-}" = privileged ]; then
        printf '{"helper_path":"%s","staging_root":"%s/staging","binaries":{"panel":"%s","telemt":"/usr/bin/telemt"}}\n' "$HELPER_FILE" "$DATA_DIR" "$PANEL_BIN"
        return
      fi
      "$@"
    }
    install_sudoers() {
      case "$scenario" in root|root-*) [ "$RUN_AS" = root ] ;; *) [ "$RUN_AS" = user ] && [ "$SYSTEM_USER" = nobody ] ;; esac
      gen_privileged_policy >"$WORK/generated-policy"
      grep -q '"telemt":"/usr/bin/telemt"' "$WORK/generated-policy"
      PRIV_PENDING=1
      printf new-policy >"$POLICY_FILE"; printf new-helper >"$HELPER_FILE"
      if [ "$RUN_AS" = root ]; then rm -f "$SUDOERS_FILE"; else gen_sudoers >"$SUDOERS_FILE"; fi
      [ "$scenario" != policy-fail ]
    }
    restore_privilege_files() {
      rm -f "$POLICY_FILE" "$HELPER_FILE"; printf old-sudoers >"$SUDOERS_FILE"; PRIV_PENDING=0
    }
    restart_retained_panel() {
      if [ "$scenario" = restart-fail ] && [ ! -f "$WORK/failed" ]; then touch "$WORK/failed"; return 1; fi
      if [ "$scenario" = restart-fail ] || [ "$scenario" = policy-fail ]; then
        cmp "$CONFIG_FILE" "$WORK/original.toml" && [ ! -e "$POLICY_FILE" ] && [ "$(cat "$PANEL_BIN")" = original-binary ] || exit 88
      fi
    }
    case "$scenario" in dry) DRY_RUN=1 ;; no-start) NO_START=1 ;; esac
    do_update_existing
  ) >"$WORK/output" 2>&1; then result=0; else result=$?; fi
  case "$scenario" in
    policy-fail|restart-fail)
      [ "$result" != 0 ]; [ "$(cat "$WORK/bin/panel")" = original-binary ]; cmp "$WORK/config/config.toml" "$WORK/original.toml"
      [ ! -e "$WORK/protected/policy.json" ]; [ ! -e "$WORK/libexec/helper" ]; [ "$(cat "$WORK/sudoers/panel")" = old-sudoers ] ;;
    mismatched-policy|root-sudo-mismatched-policy) [ "$result" != 0 ]; [ ! -e "$WORK/calls" ]; cmp "$WORK/config/config.toml" "$WORK/original.toml"; [ "$(cat "$WORK/protected/policy.json")" = other-instance-policy ]; [ "$(cat "$WORK/bin/panel")" = original-binary ] ;;
    root-mismatched-policy)
      [ "$result" = 0 ] || { cat "$WORK/output"; exit 1; }
      cmp "$WORK/config/config.toml" "$WORK/original.toml"; cmp "$CANDIDATE" "$WORK/bin/panel"
      [ ! -e "$WORK/generated-policy" ]; [ "$(cat "$WORK/protected/policy.json")" = other-instance-policy ]
      [ "$(cat "$WORK/libexec/helper")" = other-instance-helper ] ;;
    root|manual|direct) [ "$result" = 0 ] || { cat "$WORK/output"; exit 1; }; cmp "$WORK/config/config.toml" "$WORK/original.toml"; [ ! -e "$WORK/generated-policy" ]; [ ! -e "$WORK/libexec/helper" ] ;;
    inline-manual|inline-direct)
      [ "$result" != 0 ]; [ ! -e "$WORK/calls" ]; [ ! -e "$WORK/generated-policy" ]
      cmp "$WORK/config/config.toml" "$WORK/original.toml"; [ "$(cat "$WORK/bin/panel")" = original-binary ]; [ "$(cat "$WORK/sudoers/panel")" = old-sudoers ] ;;
    sudoers-symlink|sudoers-directory)
      [ "$result" != 0 ]; [ ! -e "$WORK/calls" ]; [ ! -e "$WORK/generated-policy" ]
      cmp "$WORK/config/config.toml" "$WORK/original.toml"; [ "$(cat "$WORK/bin/panel")" = original-binary ]
      if [ "$scenario" = sudoers-symlink ]; then [ -L "$WORK/sudoers/panel" ]; [ "$(cat "$WORK/sudoers/untouched")" = old-sudoers ]; else [ -d "$WORK/sudoers/panel" ]; fi ;;
    writable-ancestor|nonroot-ancestor|legacy-denied)
      [ "$result" != 0 ]; [ ! -e "$WORK/calls" ]; [ ! -e "$WORK/generated-policy" ]
      cmp "$WORK/config/config.toml" "$WORK/original.toml"; [ "$(cat "$WORK/bin/panel")" = original-binary ] ;;
    matching-policy) [ "$result" = 0 ] || { cat "$WORK/output"; exit 1; }; cmp "$WORK/config/config.toml" "$WORK/original.toml"; [ ! -e "$WORK/generated-policy" ]; [ "$(cat "$WORK/protected/policy.json")" = other-instance-policy ] ;;
    dry) [ "$result" = 0 ] || { cat "$WORK/output"; exit 1; }; [ ! -e "$WORK/calls" ]; cmp "$WORK/config/config.toml" "$WORK/original.toml" ;;
    *) [ "$result" = 0 ] || { cat "$WORK/output"; exit 1; }; cmp "$CANDIDATE" "$WORK/bin/panel"; grep -q '/usr/bin/telemt' "$WORK/config/config.toml" ;;
  esac
  [ "$(stat -c %a "$WORK/config/config.toml")" = 640 ]
  printf 'PASS: systemd automatic privilege transaction %s\n' "$scenario"
done
