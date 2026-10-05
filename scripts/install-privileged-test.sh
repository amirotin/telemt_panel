#!/bin/sh
# Privileged policy generators and migration use disposable fixtures only.
set -eu
HERE=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM
TP_SOURCED=1
. "$HERE/../install.sh"
trap 'rm -rf "$TMP"' EXIT INT TERM
L=en
COLOR=0
SYSTEM_USER=telemt-panel
INIT=sysvinit
PANEL_BIN=/usr/local/bin/telemt-panel
HELPER_FILE=/usr/local/libexec/telemt-panel-privileged
TELEMT_BIN=/usr/local/bin/telemt
DATA_DIR=/var/lib/telemt-panel
POLICY_FILE=/etc/telemt-panel-privileged/policy.json
gen_sudoers >"$TMP/sudoers"
if [ "$(grep -c 'privileged --policy' "$TMP/sudoers" || true)" != 7 ]; then
	printf '%s\n' 'FAIL: sudoers must allow six fixed helper mutations and readonly inspect'
	exit 1
fi
if grep -Eq 'NOPASSWD: .*/?(cp|chmod|mv) ' "$TMP/sudoers"; then
	printf '%s\n' 'FAIL: sudoers still permits legacy staged-file operations'
	exit 1
fi
gen_privileged_policy >"$TMP/policy"
if ! grep -qF '"version":2' "$TMP/policy" || ! grep -qF '"helper_path":"/usr/local/libexec/telemt-panel-privileged"' "$TMP/policy" || ! grep -qF '"panel":"/usr/local/bin/telemt-panel"' "$TMP/policy" || ! grep -qF '"staging_root":"/var/lib/telemt-panel/staging"' "$TMP/policy"; then
	printf '%s\n' 'FAIL: installer did not generate the stable-helper version 2 policy'
	exit 1
fi
printf '%s\n' 'PASS: privileged helper argv and policy contract'

# Refuse a policy the installed helper rejects, and restore both prior files.
DRY_RUN=0
RUN_AS=user
fixture_privilege() { if [ "$1" = stat ] && [ "$2" = -c ] && [ "$3" = %u ]; then printf '0\n'; else "$@"; fi; }
SUDO=fixture_privilege
TEMP_DIR="$TMP/private"
mkdir -p "$TEMP_DIR" "$TMP/protected" "$TMP/sudoers.d"
POLICY_FILE="$TMP/protected/policy.json"
SUDOERS_FILE="$TMP/sudoers.d/panel"
PANEL_BIN="$TMP/panel-helper"
HELPER_FILE="$TMP/protected/stable-helper"
STAGED_BIN="$PANEL_BIN"
TELEMT_BIN="$TMP/telemt"
DATA_DIR="$TMP/data"
printf '%s' 'old-policy' >"$POLICY_FILE"
printf '%s' 'old-sudoers' >"$SUDOERS_FILE"
printf '%s' 'old-helper' >"$HELPER_FILE"
chmod 0755 "$HELPER_FILE"
printf '#!/bin/sh\nexit 1\n' >"$PANEL_BIN"
chmod 0755 "$PANEL_BIN"
run() { if [ "$1" = chown ]; then return 0; fi; "$@"; }
publish_root_file() {
	# The fixture preserves real atomic rename, replacing root owner setting.
	cp "$1" "$2.fixture-new"
	chmod "$3" "$2.fixture-new"
	mv -f "$2.fixture-new" "$2"
}
if install_sudoers; then
	printf '%s\n' 'FAIL: helper rejected policy but installer accepted migration'
	exit 1
fi
if [ "$(cat "$HELPER_FILE")" != old-helper ] || [ "$(cat "$POLICY_FILE")" != old-policy ] || [ "$(cat "$SUDOERS_FILE")" != old-sudoers ]; then
	printf '%s\n' 'FAIL: rejected migration changed prior policy or sudoers'
	exit 1
fi
printf '%s\n' 'PASS: rejected privileged policy migration rolls back'

printf '#!/bin/sh\nexit 0\n' >"$PANEL_BIN"
chmod 0755 "$PANEL_BIN"
for boundary in before after; do
  printf '%s' 'old-policy' >"$POLICY_FILE"
  printf '%s' 'old-sudoers' >"$SUDOERS_FILE"
  printf '%s' 'old-helper' >"$HELPER_FILE"
  FAIL_SUDOERS_ONCE=1
  publish_root_file() {
    if [ "$2" = "$SUDOERS_FILE" ] && [ "$FAIL_SUDOERS_ONCE" = 1 ]; then
      FAIL_SUDOERS_ONCE=0
      if [ "$boundary" = after ]; then cp "$1" "$2.fixture-new"; mv -f "$2.fixture-new" "$2"; fi
      return 1
    fi
    cp "$1" "$2.fixture-new"
    chmod "$3" "$2.fixture-new"
    mv -f "$2.fixture-new" "$2"
  }
  if install_sudoers; then printf '%s\n' "FAIL: $boundary sudoers failure accepted"; exit 1; fi
  if [ "$(cat "$HELPER_FILE")" != old-helper ] || [ "$(cat "$POLICY_FILE")" != old-policy ] || [ "$(cat "$SUDOERS_FILE")" != old-sudoers ]; then
    printf '%s\n' "FAIL: $boundary sudoers failure did not restore prior root files"; exit 1
  fi
done
printf '%s\n' 'PASS: sudoers failure before/after publication restores policy and sudoers'
