#!/bin/sh
# Every authority-placement failure must leave disposable old state untouched.
set -eu
HERE=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
TP_SOURCED=1
. "$HERE/../install.sh"
trap 'rm -rf "$TMP"' EXIT INT TERM
L=en
COLOR=0
DRY_RUN=0
RUN_AS=user
INIT=sysvinit
fixture_privilege() { if [ "$1" = stat ] && [ "$2" = -c ] && [ "$3" = %u ]; then printf '0\n'; else "$@"; fi; }
SUDO=fixture_privilege
run() { if [ "$1" = chown ]; then return 0; fi; "$@"; }
publish_root_file() { cp "$1" "$2.fixture-new"; chmod "$3" "$2.fixture-new"; mv -f "$2.fixture-new" "$2"; }
for kind in helper_sudoers helper_service helper_config helper_data policy_config policy_data policy_ancestor helper_inode policy_sudoers policy_config_inode; do
  WORK="$TMP/$kind"
  mkdir -p "$WORK/libexec" "$WORK/policy" "$WORK/config" "$WORK/data" "$WORK/bin" "$WORK/sudoers" "$WORK/service" "$WORK/temp"
  chmod 0700 "$WORK/config" "$WORK/data" "$WORK/policy"
  CONFIG_DIR="$WORK/config"; DATA_DIR="$WORK/data"
  CONFIG_FILE="$CONFIG_DIR/config.toml"; TELEMT_CONFIG="$WORK/telemt.toml"
  SERVICE_FILE="$WORK/service/panel"; SERVICE_NAME=telemt-panel; TELEMT_SVC=telemt
  PANEL_BIN="$WORK/bin/panel"; TELEMT_BIN="$WORK/bin/telemt"
  POLICY_FILE="$WORK/policy/policy.json"; HELPER_FILE="$WORK/libexec/helper"
  SUDOERS_FILE="$WORK/sudoers/panel"; TEMP_DIR="$WORK/temp"; STAGED_BIN="$WORK/candidate"
  printf '#!/bin/sh\nexit 0\n' >"$STAGED_BIN"; chmod 0755 "$STAGED_BIN"
  for path in "$HELPER_FILE" "$POLICY_FILE" "$SUDOERS_FILE" "$SERVICE_FILE" "$CONFIG_FILE" "$TELEMT_CONFIG" "$PANEL_BIN" "$TELEMT_BIN"; do printf 'old:%s\n' "$path" >"$path"; done
  case "$kind" in
    helper_sudoers) HELPER_FILE="$SUDOERS_FILE" ;;
    helper_service) HELPER_FILE="$SERVICE_FILE" ;;
    helper_config) HELPER_FILE="$CONFIG_DIR/helper" ;;
    helper_data) HELPER_FILE="$DATA_DIR/helper" ;;
    policy_config) POLICY_FILE="$CONFIG_DIR/policy.json" ;;
    policy_data) POLICY_FILE="$DATA_DIR/policy.json" ;;
    policy_ancestor) POLICY_FILE="$WORK/policy.json" ;;
    helper_inode) rm "$HELPER_FILE"; ln "$SERVICE_FILE" "$HELPER_FILE" ;;
    policy_sudoers) POLICY_FILE="$SUDOERS_FILE" ;;
    policy_config_inode) rm "$POLICY_FILE"; ln "$CONFIG_FILE" "$POLICY_FILE" ;;
  esac
  before=$(find "$WORK" -type f ! -path "$TEMP_DIR/*" -exec sha256sum '{}' \; | sort)
  config_mode=$(stat -c '%u:%g:%a' "$CONFIG_DIR"); data_mode=$(stat -c '%u:%g:%a' "$DATA_DIR")
  if install_sudoers; then printf 'FAIL: unsafe placement accepted: %s\n' "$kind"; exit 1; fi
  after=$(find "$WORK" -type f ! -path "$TEMP_DIR/*" -exec sha256sum '{}' \; | sort)
  [ "$before" = "$after" ] || { printf 'FAIL: files changed: %s\n' "$kind"; exit 1; }
  [ "$config_mode" = "$(stat -c '%u:%g:%a' "$CONFIG_DIR")" ] || { printf 'FAIL: config dir changed: %s\n' "$kind"; exit 1; }
  [ "$data_mode" = "$(stat -c '%u:%g:%a' "$DATA_DIR")" ] || { printf 'FAIL: data dir changed: %s\n' "$kind"; exit 1; }
done
# Suitable existing parents keep their exact modes, including a private helper dir.
PRIV_PARENT="$TMP/private-parent"
mkdir "$PRIV_PARENT"; chmod 0700 "$PRIV_PARENT"
before_mode=$(stat -c '%u:%g:%a' "$PRIV_PARENT")
ensure_privilege_directory "$PRIV_PARENT" 0755
[ "$before_mode" = "$(stat -c '%u:%g:%a' "$PRIV_PARENT")" ] || { printf '%s\n' 'FAIL: existing helper parent was widened'; exit 1; }
chmod 0755 "$PRIV_PARENT"
before_mode=$(stat -c '%u:%g:%a' "$PRIV_PARENT")
if ensure_privilege_directory "$PRIV_PARENT" 0700; then printf '%s\n' 'FAIL: broad existing policy parent accepted'; exit 1; fi
[ "$before_mode" = "$(stat -c '%u:%g:%a' "$PRIV_PARENT")" ] || { printf '%s\n' 'FAIL: existing policy parent was narrowed'; exit 1; }
printf '%s\n' 'PASS: privilege role/runtime placement rejections preserve old files and directories'
