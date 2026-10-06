#!/bin/sh
# Current-schema migration uses the published CLI and disposable files only.
# Fixture callbacks and globals are consumed by the sourced installer.
# shellcheck disable=SC2034,SC2317,SC1090
set -eu
HERE=$(CDPATH="" cd -- "$(dirname "$0")" && pwd)
TP_TEST_BINARY="${TP_TEST_BINARY:-$HERE/../telemt-panel}"
[ -x "$TP_TEST_BINARY" ] || { printf 'Set TP_TEST_BINARY to an executable panel binary for installer migration tests.\n' >&2; exit 1; }
TMP=$(mktemp -d)
TP_SOURCED=1
. "${TP_TEST_INSTALLER:-$HERE/../install.sh}"
trap 'rm -rf "$TMP"' EXIT INT TERM
L=en; COLOR=0; setup_colors
fixture_root() { if [ "$1" = stat ] && [ "$2" = -c ] && [ "$3" = %u ]; then printf '0\n'; else "$@"; fi; }
SUDO=fixture_root; TEMP_DIR="$TMP"; UPDATE_PROBE_DIR="$TMP/probe"
mkdir "$UPDATE_PROBE_DIR"
STAGED_BIN="$TP_TEST_BINARY"
CONFIG_FILE="$TMP/config.toml"; UPDATE_SOURCE="$TMP/original.toml"
cat >"$CONFIG_FILE" <<'EOF'
listen = "127.0.0.1:48280"
data_dir = "/var/lib/telemt-panel"
[telemt]
url = "http://127.0.0.1:9091"
[auth]
disabled = true
[updates]
# /bin/telemt is a comment that must survive
telemt_binary_path = '/bin/telemt' # preserve this comment
github_token = 'secret /bin/telemt # [updates]'
[host]
service_manager = "systemd"
EOF
chmod 0640 "$CONFIG_FILE"
cp -p "$CONFIG_FILE" "$UPDATE_SOURCE"
staged_inspect config inspect --config "$UPDATE_SOURCE" >"$TMP/report.json"
PANEL_BIN=/usr/local/bin/telemt-panel; TELEMT_BIN=/bin/telemt
DATA_DIR=/var/lib/telemt-panel; HELPER_FILE=/usr/local/libexec/telemt-panel-privileged
POLICY_FILE="$TMP/preflight-policy/policy.json"
prepare_privilege_migration "$TMP/report.json"
[ "$TELEMT_BIN" = /usr/bin/telemt ]
grep -qF "telemt_binary_path = \"/usr/bin/telemt\" # preserve this comment" "$PRIV_CONFIG_CANDIDATE"
grep -qF "github_token = 'secret /bin/telemt # [updates]'" "$PRIV_CONFIG_CANDIDATE"
grep -qF '# /bin/telemt is a comment that must survive' "$PRIV_CONFIG_CANDIDATE"
publish_privilege_config
[ "$(stat -c %a "$CONFIG_FILE")" = 640 ]
restore_privilege_config
cmp "$CONFIG_FILE" "$TMP/original.toml"
[ "$(stat -c %a "$CONFIG_FILE")" = 640 ]
printf '%s\n' 'PASS: merged-/usr config migration and metadata rollback'

for shape in absent-key absent-table multiline-array multiline-secret quoted-key dotted-key; do
  UPDATE_SOURCE="$TMP/shape-original.toml"
  cp -p "$TMP/original.toml" "$UPDATE_SOURCE"
  case "$shape" in
    absent-key) awk '!/^telemt_binary_path =/' "$UPDATE_SOURCE" >"$TMP/shape" ;;
    absent-table) awk '!/^\[updates\]/ && !/^telemt_binary_path =/ && !/^github_token =/' "$UPDATE_SOURCE" >"$TMP/shape" ;;
    multiline-array) { printf 'trusted_proxies = [\n  "127.0.0.1/32", # [updates]\n]\n'; cat "$UPDATE_SOURCE"; } >"$TMP/shape" ;;
    multiline-secret) awk '/^github_token =/ {print "github_token = \047\047\047secret\n[updates]\ntelemt_binary_path = \"/bin/telemt\"\n\047\047\047"; next} {print}' "$UPDATE_SOURCE" >"$TMP/shape" ;;
    quoted-key) awk '/^telemt_binary_path =/ {sub(/telemt_binary_path/,"\"telemt_binary_path\"")} {print}' "$UPDATE_SOURCE" >"$TMP/shape" ;;
    dotted-key) awk 'BEGIN {print "updates.telemt_binary_path = \"/bin/telemt\""} /^\[updates\]/ || /^telemt_binary_path =/ || /^github_token =/ {next} {print}' "$UPDATE_SOURCE" >"$TMP/shape" ;;
  esac
  cp "$TMP/shape" "$UPDATE_SOURCE"; cp -p "$UPDATE_SOURCE" "$CONFIG_FILE"
  staged_inspect config inspect --config "$UPDATE_SOURCE" >"$TMP/report.json"
  TELEMT_BIN=/bin/telemt; PRIV_CONFIG_CANDIDATE=""
  if prepare_privilege_migration "$TMP/report.json" >"$TMP/shape.log" 2>&1; then shape_result=0; else shape_result=$?; fi
  case "$shape" in
    multiline-secret|quoted-key|dotted-key) [ "$shape_result" != 0 ] ;;
    *) [ "$shape_result" = 0 ] || { cat "$TMP/shape.log"; exit 1; }; grep -q 'telemt_binary_path = "/usr/bin/telemt"' "$PRIV_CONFIG_CANDIDATE" ;;
  esac
  cmp "$CONFIG_FILE" "$UPDATE_SOURCE"
  printf 'PASS: conservative TOML %s\n' "$shape"
done

# A parent that becomes writable during directory preparation is refused before
# publishing or executing the privileged helper. Root sticky /tmp ancestors are
# exercised by every successful disposable transaction in this suite.
(
  WORK="$TMP/ancestry-race"
  mkdir -p "$WORK/unsafe/libexec" "$WORK/policy" "$WORK/sudoers" "$WORK/temp" "$WORK/bin" "$WORK/data" "$WORK/config"
  chmod 0700 "$WORK/policy"
  CONFIG_DIR="$WORK/config"; CONFIG_FILE="$CONFIG_DIR/config.toml"
  PANEL_BIN="$WORK/bin/panel"; TELEMT_BIN=/usr/bin/telemt; DATA_DIR="$WORK/data"
  HELPER_FILE="$WORK/unsafe/libexec/helper"; POLICY_FILE="$WORK/policy/policy.json"; SUDOERS_FILE="$WORK/sudoers/panel"
  TEMP_DIR="$WORK/temp"; RUN_AS=user; SYSTEM_USER=telemt-panel; INIT=systemd
  printf old-helper >"$HELPER_FILE"; printf old-policy >"$POLICY_FILE"; printf old-sudoers >"$SUDOERS_FILE"
  fixture_root() {
    if [ "$1" = stat ] && [ "$2" = -c ] && [ "$3" = %u ]; then printf '0\n'; return; fi
    if [ "$1" = "$HELPER_FILE" ]; then touch "$WORK/helper-executed"; fi
    "$@"
  }
  ensure_privilege_directory() { if [ "$1" = "$WORK/unsafe/libexec" ]; then chmod 0777 "$WORK/unsafe"; fi; }
  if install_sudoers pending >"$WORK/output" 2>&1; then cat "$WORK/output"; exit 1; fi
  [ ! -e "$WORK/helper-executed" ]
  [ "$(cat "$HELPER_FILE")" = old-helper ] && [ "$(cat "$POLICY_FILE")" = old-policy ] && [ "$(cat "$SUDOERS_FILE")" = old-sudoers ]
)
printf '%s\n' 'PASS: ancestry race is refused before helper publication/execution'

# The complete repair transaction must restore all four files before retrying
# the original service after a policy publication or restart failure.
for scenario in success dry race sudoers-symlink sudoers-directory policy-fail restart-fail; do
  CASE_DIR="$TMP/$scenario"
  mkdir -p "$CASE_DIR/config" "$CASE_DIR/protected" "$CASE_DIR/libexec" "$CASE_DIR/sudoers" "$CASE_DIR/bin" "$CASE_DIR/data" "$CASE_DIR/temp"
  chmod 0700 "$CASE_DIR/protected"
  cp -p "$TMP/original.toml" "$CASE_DIR/config/config.toml"
  printf old-policy >"$CASE_DIR/protected/policy.json"
  printf old-helper >"$CASE_DIR/libexec/helper"
  printf old-sudoers >"$CASE_DIR/sudoers/panel"
  case "$scenario" in
    sudoers-symlink) mv "$CASE_DIR/sudoers/panel" "$CASE_DIR/sudoers/untouched"; ln -s "$CASE_DIR/sudoers/untouched" "$CASE_DIR/sudoers/panel" ;;
    sudoers-directory) rm "$CASE_DIR/sudoers/panel"; mkdir "$CASE_DIR/sudoers/panel" ;;
  esac
  if (
    TP_SOURCED=1
    . "${TP_TEST_INSTALLER:-$HERE/../install.sh}"
    L=en; COLOR=0; setup_colors
    SUDO=fixture_root; INIT=systemd; SERVICE_MANAGER=systemd; REPAIR_USER=telemt-panel
    TEMP_DIR="$CASE_DIR/temp"; UPDATE_PROBE_DIR="$TMP/probe"; STAGED_BIN="$TP_TEST_BINARY"
    CONFIG_DIR="$CASE_DIR/config"; CONFIG_FILE="$CONFIG_DIR/config.toml"
    DATA_DIR="$CASE_DIR/data"; PANEL_BIN="$CASE_DIR/bin/panel"; TELEMT_BIN=/bin/telemt
    POLICY_FILE="$CASE_DIR/protected/policy.json"; HELPER_FILE="$CASE_DIR/libexec/helper"; SUDOERS_FILE="$CASE_DIR/sudoers/panel"
    UPDATE_SOURCE="$TEMP_DIR/removal.toml"; cp -p "$CONFIG_FILE" "$UPDATE_SOURCE"
    # This fixture changes bindings in its parser report and TOML together.
    awk -v data="$DATA_DIR" -v panel="$PANEL_BIN" -v helper="$HELPER_FILE" -v policy="$POLICY_FILE" '
      /^data_dir =/ {$0="data_dir = \"" data "\""}
      {print}
      END { print "panel_binary_path = \"" panel "\"\n[privileges]\nhelper_path = \"" helper "\"\npolicy_path = \"" policy "\"" }
    ' "$UPDATE_SOURCE" >"$TEMP_DIR/fixture"
    # panel_binary_path belongs to updates, append before [host].
    awk -v panel="$PANEL_BIN" '/^\[host\]/ {print "panel_binary_path = \"" panel "\""} !/^panel_binary_path =/ {print}' "$TEMP_DIR/fixture" >"$UPDATE_SOURCE"
    cp -p "$UPDATE_SOURCE" "$CONFIG_FILE"; cp -p "$CONFIG_FILE" "$CASE_DIR/original"
    staged_inspect config inspect --config "$UPDATE_SOURCE" >"$TEMP_DIR/removal.json"
    REMOVE_CONFIG_HASH=$(sha256_of "$UPDATE_SOURCE")
    prepare_removal() { :; }
    confirm() { if [ "$scenario" = race ]; then printf '\n# concurrent edit\n' >>"$CONFIG_FILE"; fi; return 0; }
    stop_retained_panel() { printf stop >>"$CASE_DIR/calls"; }
    install_sudoers() {
      PRIV_PENDING=1
      printf new-policy >"$POLICY_FILE"; printf new-helper >"$HELPER_FILE"; printf new-sudoers >"$SUDOERS_FILE"
      [ "$scenario" != policy-fail ]
    }
    restore_privilege_files() { printf old-policy >"$POLICY_FILE"; printf old-helper >"$HELPER_FILE"; printf old-sudoers >"$SUDOERS_FILE"; PRIV_PENDING=0; }
    restart_retained_panel() {
      if [ "$scenario" = restart-fail ] && [ ! -e "$CASE_DIR/failed" ]; then touch "$CASE_DIR/failed"; return 1; fi
      if [ "$scenario" = restart-fail ] || [ "$scenario" = policy-fail ]; then
        cmp "$CONFIG_FILE" "$CASE_DIR/original" && [ "$(cat "$POLICY_FILE")" = old-policy ] || exit 88
      fi
    }
    if [ "$scenario" = dry ]; then DRY_RUN=1; stop_retained_panel() { :; }; install_sudoers() { :; }; fi
    do_repair_privileges
  ) >"$CASE_DIR/output" 2>&1; then result=0; else result=$?; fi
  case "$scenario" in
    success) [ "$result" = 0 ] || { cat "$CASE_DIR/output"; exit 1; }; grep -q '/usr/bin/telemt' "$CASE_DIR/config/config.toml" ;;
    dry) [ "$result" = 0 ] || { cat "$CASE_DIR/output"; exit 1; }; cmp "$CASE_DIR/config/config.toml" "$CASE_DIR/original" ;;
    race) [ "$result" != 0 ]; [ ! -e "$CASE_DIR/calls" ]; grep -q 'concurrent edit' "$CASE_DIR/config/config.toml" ;;
    sudoers-symlink|sudoers-directory)
      [ "$result" != 0 ]; [ ! -e "$CASE_DIR/calls" ]; cmp "$CASE_DIR/config/config.toml" "$CASE_DIR/original"
      if [ "$scenario" = sudoers-symlink ]; then [ -L "$CASE_DIR/sudoers/panel" ]; [ "$(cat "$CASE_DIR/sudoers/untouched")" = old-sudoers ]; else [ -d "$CASE_DIR/sudoers/panel" ]; fi ;;
    *) [ "$result" != 0 ]; cmp "$CASE_DIR/config/config.toml" "$CASE_DIR/original"; [ "$(cat "$CASE_DIR/protected/policy.json")" = old-policy ] ;;
  esac
  printf 'PASS: repair transaction %s\n' "$scenario"
done
