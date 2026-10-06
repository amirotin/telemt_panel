#!/usr/bin/env bash
# Production installer/systemd/sudo wiring. Only explicitly opted-in disposable
# GitHub-hosted runners may create these services; this is never a local test.
set -euo pipefail
skip() { printf 'SKIP native worker installer: %s\n' "$*"; exit 77; }
fail() { printf 'FAIL native worker installer: %s\n' "$*" >&2; exit 1; }
[[ ${TP_NATIVE_WORKER_DISPOSABLE:-} == 1 ]] || skip 'requires TP_NATIVE_WORKER_DISPOSABLE=1'
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]] || skip 'requires a disposable GitHub-hosted runner'
[[ $EUID == 0 ]] || skip 'requires root on the disposable runner'
[[ -n ${TP_TEST_BINARY:-} && -n ${TP_TEST_RC3_BINARY:-} ]] || fail 'candidate and published RC3 binaries are required'
for tool in systemctl sudo visudo useradd userdel groupadd groupdel runuser curl python3 timeout flock sha256sum install cmp stat readlink; do
  command -v "$tool" >/dev/null || skip "missing dependency: $tool"
done
[[ $(cat /proc/1/comm) == systemd && -d /run/systemd/system ]] || skip 'systemd must be PID 1'
systemctl show --property=Version --value >/dev/null 2>&1 || skip 'systemd manager is unavailable'
for binary in "$TP_TEST_BINARY" "$TP_TEST_RC3_BINARY"; do
  [[ -f $binary && -x $binary ]] || fail "missing executable: $binary"
  python3 - "$binary" <<'PY'
import sys
with open(sys.argv[1], 'rb') as f:
    assert f.read(4) == b'\x7fELF', 'actual Linux release binaries are required'
PY
done
[[ $(timeout 15 "$TP_TEST_RC3_BINARY" version) == 'telemt-panel 1.0.0-rc.3 ('* ]] || fail 'expected published RC3'
[[ $(timeout 15 "$TP_TEST_BINARY" update-worker --protocol) == 1 ]] || fail 'candidate does not support worker protocol 1'
HERE=$(cd -- "$(dirname -- "$0")" && pwd)
INSTALLER="$HERE/../install.sh"
ROOT=$(mktemp -d /run/telemt-panel-worker-native.XXXXXXXX)
chmod 0755 "$ROOT"
TOKEN=${ROOT##*.}
ACCOUNT="tpworker${TOKEN,,}"
PANEL_SERVICE="tp-worker-panel-${TOKEN,,}"
UPDATER_SERVICE="$PANEL_SERVICE-updater"
TELEMT_SERVICE="tp-worker-telemt-${TOKEN,,}"
PANEL_UNIT="/etc/systemd/system/$PANEL_SERVICE.service"
UPDATER_UNIT="/etc/systemd/system/$UPDATER_SERVICE.service"
TELEMT_UNIT="/etc/systemd/system/$TELEMT_SERVICE.service"
SUDOERS="/etc/sudoers.d/tp-worker-${TOKEN,,}"
HELPER="$ROOT/libexec/helper"
POLICY="$ROOT/protected/policy.json"
PANEL_BIN="$ROOT/bin/telemt-panel"
TELEMT_BIN="$ROOT/bin/telemt"
CONFIG_FILE="$ROOT/config/config.toml"
DATA_DIR="$ROOT/data"
ACCOUNT_CREATED=0; GROUP_CREATED=0; UNITS_CREATED=0; SUDOERS_CREATED=0
cleanup_native_worker() {
  local result=$?
  trap - EXIT INT TERM
  if (( result != 0 )); then
    [[ ! -f $ROOT/installer.log ]] || tail -100 "$ROOT/installer.log" >&2
    if (( UNITS_CREATED )); then journalctl -u "$PANEL_SERVICE" -u "$UPDATER_SERVICE" --no-pager -n 80 >&2 || true; fi
  fi
  if (( UNITS_CREATED )); then
    systemctl stop "$UPDATER_SERVICE" "$PANEL_SERVICE" "$TELEMT_SERVICE" 2>/dev/null || true
    rm -f -- "$PANEL_UNIT" "$UPDATER_UNIT" "$TELEMT_UNIT"
    systemctl daemon-reload || true
    systemctl reset-failed "$PANEL_SERVICE" "$UPDATER_SERVICE" "$TELEMT_SERVICE" 2>/dev/null || true
  fi
  if (( SUDOERS_CREATED )); then rm -f -- "$SUDOERS"; fi
  if (( ACCOUNT_CREATED )); then userdel "$ACCOUNT" || true; fi
  if (( GROUP_CREATED )) && getent group "$ACCOUNT" >/dev/null; then groupdel "$ACCOUNT" || true; fi
  rm -rf -- "$ROOT"
  exit "$result"
}
trap cleanup_native_worker EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for path in "$PANEL_UNIT" "$UPDATER_UNIT" "$TELEMT_UNIT" "$SUDOERS"; do
  [[ ! -e $path && ! -L $path ]] || fail "fixture name collision: $path"
done
! getent passwd "$ACCOUNT" >/dev/null || fail 'fixture account already exists'
! getent group "$ACCOUNT" >/dev/null || fail 'fixture group already exists'
groupadd --system "$ACCOUNT"; GROUP_CREATED=1
useradd --system --gid "$ACCOUNT" --no-create-home --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$ACCOUNT"
ACCOUNT_CREATED=1
SERVICE_UID=$(id -u "$ACCOUNT")
install -d -m 0755 "$ROOT/bin" "$ROOT/releases" "$ROOT/libexec"
install -d -m 0700 "$ROOT/protected"
install -d -m 0750 -o "$ACCOUNT" -g "$ACCOUNT" "$ROOT/config" "$DATA_DIR" "$DATA_DIR/staging"
install -m 0755 "$TP_TEST_BINARY" "$ROOT/releases/candidate"
install -m 0755 "$TP_TEST_RC3_BINARY" "$ROOT/releases/rc3"
install -m 0755 "$ROOT/releases/rc3" "$PANEL_BIN"
printf '#!/bin/sh\nprintf "telemt fixture 0.0.0\\n"\n' >"$TELEMT_BIN"; chmod 0755 "$TELEMT_BIN"
PORT=$(python3 - <<'PY'
import socket
with socket.socket() as s:
    s.bind(('127.0.0.1', 0))
    print(s.getsockname()[1])
PY
)
BASE_URL="http://127.0.0.1:$PORT"
PASSWORD=$(python3 -c 'import secrets; print(secrets.token_hex(24))')
PASSWORD_HASH=$(printf '%s\n' "$PASSWORD" | "$ROOT/releases/candidate" hash-password)
printf '%s' "$PASSWORD" | python3 -c 'import json, sys; json.dump({"username":"native-admin","password":sys.stdin.read()},open(sys.argv[1],"w"))' "$ROOT/login.json"
unset PASSWORD
chmod 0600 "$ROOT/login.json"
cat >"$CONFIG_FILE" <<EOF
listen = "127.0.0.1:$PORT"
data_dir = "$DATA_DIR"
[telemt]
url = "http://127.0.0.1:1"
[auth]
username = "native-admin"
password_hash = "$PASSWORD_HASH"
[store]
driver = "memory"
[host]
service_manager = "systemd"
panel_service = "$PANEL_SERVICE"
telemt_service = "$TELEMT_SERVICE"
[privileges]
mode = "auto"
helper_path = "$HELPER"
policy_path = "$POLICY"
[updates]
panel_binary_path = "$PANEL_BIN"
telemt_binary_path = "$TELEMT_BIN"
EOF
chown "$ACCOUNT:$ACCOUNT" "$CONFIG_FILE"; chmod 0600 "$CONFIG_FILE"
"$ROOT/releases/rc3" config check --format current --config "$CONFIG_FILE"
cat >"$ROOT/fail-start-once" <<EOF
#!/bin/sh
if [ -f "$ROOT/fail-next-start" ]; then
  rm -f "$ROOT/fail-next-start"
  exit 1
fi
EOF
chmod 0755 "$ROOT/fail-start-once"
UNITS_CREATED=1
cat >"$PANEL_UNIT" <<EOF
[Unit]
Description=Disposable worker installer fixture
[Service]
Type=simple
User=$ACCOUNT
Group=$ACCOUNT
WorkingDirectory=$DATA_DIR
ExecStartPre=+$ROOT/fail-start-once
ExecStart=$PANEL_BIN --config $CONFIG_FILE
Environment=KEEP_THIS=unchanged
Restart=no
EOF
cat >"$TELEMT_UNIT" <<'EOF'
[Service]
Type=oneshot
ExecStart=/usr/bin/true
RemainAfterExit=yes
EOF
export FIXTURE_ROOT="$ROOT" FIXTURE_INSTALLER="$INSTALLER" FIXTURE_ACCOUNT="$ACCOUNT"
export FIXTURE_PANEL_SERVICE="$PANEL_SERVICE" FIXTURE_TELEMT_SERVICE="$TELEMT_SERVICE" FIXTURE_SUDOERS="$SUDOERS"
fixture_installer() {
  bash -c '
    set -eu
    TP_SOURCED=1
    . "$FIXTURE_INSTALLER"
    L=en; COLOR=0; setup_colors
    INIT=systemd; RUN_AS=user; SYSTEM_USER="$FIXTURE_ACCOUNT"
    BIN_DIR="$FIXTURE_ROOT/bin"; PANEL_BIN="$BIN_DIR/telemt-panel"; TELEMT_BIN="$BIN_DIR/telemt"
    SERVICE_NAME="$FIXTURE_PANEL_SERVICE"; TELEMT_SVC="$FIXTURE_TELEMT_SERVICE"
    CONFIG_DIR="$FIXTURE_ROOT/config"; CONFIG_FILE="$CONFIG_DIR/config.toml"; DATA_DIR="$FIXTURE_ROOT/data"
    HELPER_FILE="$FIXTURE_ROOT/libexec/helper"; POLICY_FILE="$FIXTURE_ROOT/protected/policy.json"
    SUDOERS_FILE="$FIXTURE_SUDOERS"; LOG_FILE="$FIXTURE_ROOT/panel.log"
    if [ "$1" = bootstrap-rc3 ]; then
      STAGED_BIN="$FIXTURE_ROOT/releases/rc3"
      install_sudoers
    else
      main --yes --lang en --binary "$FIXTURE_ROOT/releases/candidate"
    fi
  ' native-worker-installer "$@" >"$ROOT/installer.log" 2>&1
}
SUDOERS_CREATED=1
fixture_installer bootstrap-rc3
visudo -cf "$SUDOERS" >/dev/null
systemctl daemon-reload
systemctl start "$PANEL_SERVICE" "$TELEMT_SERVICE"
assert_runtime() {
  local expected=$1 pid attempt
  systemctl is-active --quiet "$PANEL_SERVICE" || fail 'panel unit is inactive'
  pid=$(systemctl show "$PANEL_SERVICE" --property=MainPID --value)
  [[ $(stat -c %u "/proc/$pid") == "$SERVICE_UID" ]] || fail 'runtime UID changed'
  cmp "$expected" "/proc/$pid/exe" || fail 'running executable differs from expected release'
  for attempt in {1..100}; do
    if curl --silent --fail --max-time 1 "$BASE_URL/api/health" >"$ROOT/health.json"; then return; fi
    sleep 0.2
  done
  fail "runtime health did not become available after $attempt attempts"
}
assert_runtime "$ROOT/releases/rc3"
cp -p "$PANEL_UNIT" "$ROOT/old-unit"; cp -p "$SUDOERS" "$ROOT/old-sudoers"
cp -p "$CONFIG_FILE" "$ROOT/old-config"; cp -p "$POLICY" "$ROOT/old-policy"
touch "$ROOT/fail-next-start"
if fixture_installer update; then fail 'installer accepted an actual systemd restart failure'; fi
[[ ! -e $ROOT/fail-next-start ]] || fail 'fixture never reached systemd restart'
cmp "$ROOT/old-unit" "$PANEL_UNIT"; cmp "$ROOT/old-sudoers" "$SUDOERS"
cmp "$ROOT/old-config" "$CONFIG_FILE"; cmp "$ROOT/old-policy" "$POLICY"
cmp "$ROOT/releases/rc3" "$HELPER"
[[ ! -e $UPDATER_UNIT && ! -e $PANEL_BIN.start && ! -e $DATA_DIR/updater/registration.json ]] || fail 'failed migration left worker files'
assert_runtime "$ROOT/releases/rc3"
printf 'PASS native worker installer: failed candidate restored RC3, helper, policy, config, unit and sudoers\n'
fixture_installer update
assert_runtime "$ROOT/releases/candidate"
[[ ! -e $HELPER && ! -e $POLICY ]] || fail 'verified migration retained the duplicate helper'
[[ $(stat -c '%u:%a' "$PANEL_BIN.start") == 0:755 ]] || fail 'startup wrapper is not root-owned executable'
[[ $(systemctl show "$UPDATER_SERVICE" --property=User --value) == "$ACCOUNT" ]] || fail 'updater UID differs from panel'
grep -qFx 'Environment=KEEP_THIS=unchanged' "$PANEL_UNIT" || fail 'retained unit overrides lost'
visudo -cf "$SUDOERS" >/dev/null
as_service() { runuser -u "$ACCOUNT" -- "$@"; }
for binary in "$PANEL_BIN" "$TELEMT_BIN"; do
  for destination in "$binary" "$binary.bak"; do
    as_service sudo -n -l -- "$(command -v install)" -m 0755 /dev/stdin "$destination.tmp" >/dev/null
    as_service sudo -n -l -- "$(command -v mv)" -f "$destination.tmp" "$destination" >/dev/null
  done
  for suffix in .bak .tmp .bak.tmp; do as_service sudo -n -l -- "$(command -v rm)" -f "$binary$suffix" >/dev/null; done
done
for service in "$PANEL_SERVICE" "$TELEMT_SERVICE"; do
  for action in start stop restart; do as_service sudo -n -l -- "$(command -v systemctl)" "$action" "$service" >/dev/null; done
done
as_service sudo -n -l -- "$(command -v systemctl)" restart --no-block "$UPDATER_SERVICE" >/dev/null
as_service "$PANEL_BIN" update-worker --recover --state-dir "$DATA_DIR/updater"
systemctl start "$UPDATER_SERVICE"
[[ $(systemctl show "$UPDATER_SERVICE" --property=Result --value) == success ]] || fail 'actual no-queue worker invocation failed'
curl --silent --show-error --fail --max-time 10 -H 'Content-Type: application/json' --data-binary "@$ROOT/login.json" -c "$ROOT/cookies" "$BASE_URL/api/auth/login" >"$ROOT/login-result.json"
curl --silent --show-error --fail --max-time 10 -b "$ROOT/cookies" "$BASE_URL/api/host" >"$ROOT/host.json"
python3 - "$ROOT/host.json" "$DATA_DIR/updater/registration.json" "$(command -v systemctl)" "$UPDATER_SERVICE" <<'PY'
import json, sys
host = json.load(open(sys.argv[1]))
registration = json.load(open(sys.argv[2]))
assert host['privileges_mode'] == 'sudo', host
for cap in ['self_update', 'restart_panel', 'start_telemt', 'stop_telemt', 'restart_telemt']:
    assert host['caps'][cap], (cap, host)
assert registration == {'version': 1, 'command': [sys.argv[3], 'restart', '--no-block', sys.argv[4]]}, registration
PY
printf 'PASS native worker installer: real RC3 migration, exact sudo grants, wrapper, updater UID, no-queue execution and authenticated self_update\n'
