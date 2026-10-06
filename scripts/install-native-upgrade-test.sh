#!/usr/bin/env bash
# Real systemd/sudo regression, exclusively for an explicitly opted-in disposable host.
# sudo env TP_NATIVE_TEST=1 TP_TEST_BINARY=/path/to/candidate \
#   TP_TEST_RC2_BINARY=/path/to/published-rc2 bash scripts/install-native-upgrade-test.sh
# No downloads, mock service manager, repair after upgrade, or installed host data.
set -euo pipefail

skip() { printf 'SKIP native installer upgrade: %s\n' "$*"; exit 77; }
fail() { printf 'FAIL native installer upgrade: %s\n' "$*" >&2; exit 1; }
[[ ${TP_NATIVE_TEST:-} == 1 ]] || skip 'requires TP_NATIVE_TEST=1 on a disposable host'
[[ ${GITHUB_ACTIONS:-} == true ]] || skip 'requires a disposable GitHub Actions runner'
[[ $EUID == 0 ]] || skip 'requires root (invoke with sudo env)'
[[ -n ${TP_TEST_BINARY:-} && -n ${TP_TEST_RC2_BINARY:-} ]] || fail 'both candidate and published RC2 binaries are required'
for tool in systemctl sudo visudo useradd userdel groupadd groupdel runuser curl python3 timeout sha256sum install cmp stat readlink; do
  command -v "$tool" >/dev/null || skip "missing dependency: $tool"
done
[[ $(cat /proc/1/comm) == systemd && -d /run/systemd/system ]] || skip 'systemd must be PID 1'
systemctl show --property=Version --value >/dev/null 2>&1 || skip 'systemd manager is unavailable'
[[ $(readlink -f /bin) == /usr/bin ]] || skip 'requires merged-/usr (/bin -> /usr/bin)'
HELPER=/usr/local/libexec/telemt-panel-privileged
POLICY=/etc/telemt-panel-privileged/policy.json
for path in "$HELPER" "$(dirname "$POLICY")"; do
  [[ ! -e $path && ! -L $path ]] || fail "disposable runner already has privileged installation: $path"
done

HERE=$(cd -- "$(dirname -- "$0")" && pwd)
INSTALLER="$HERE/../install.sh"
[[ -f $INSTALLER ]] || fail 'install.sh is missing'
for binary in "$TP_TEST_BINARY" "$TP_TEST_RC2_BINARY"; do
  [[ -f $binary && -x $binary ]] || fail "binary is not executable: $binary"
  python3 - "$binary" <<'PY'
import sys
with open(sys.argv[1], 'rb') as f:
    assert f.read(4) == b'\x7fELF', 'fixture requires actual Linux release binaries'
PY
done
CANDIDATE_VERSION=$(timeout 15 "$TP_TEST_BINARY" version)
RC2_VERSION=$(timeout 15 "$TP_TEST_RC2_BINARY" version)
[[ $RC2_VERSION == 'telemt-panel 1.0.0-rc.2 ('* ]] || fail "expected actual published RC2, got: $RC2_VERSION"
[[ $CANDIDATE_VERSION == 'telemt-panel '* ]] || fail 'candidate version command is invalid'
[[ $CANDIDATE_VERSION != "$RC2_VERSION" ]] || fail 'candidate must differ from RC2'

# /run avoids writable binary/helper ancestry while keeping all created data ephemeral.
ROOT=$(mktemp -d /run/telemt-panel-native.XXXXXXXX)
chmod 0755 "$ROOT"
TOKEN=${ROOT##*.}
ACCOUNT="tpnative${TOKEN,,}"
PANEL_SERVICE="tp-native-panel-${TOKEN,,}"
TELEMT_SERVICE="tp-native-telemt-${TOKEN,,}"
PANEL_UNIT="/etc/systemd/system/$PANEL_SERVICE.service"
TELEMT_UNIT="/etc/systemd/system/$TELEMT_SERVICE.service"
SUDOERS="/etc/sudoers.d/tp-native-${TOKEN,,}"
TELEMT_BIN="/usr/bin/tp-native-telemt-${TOKEN,,}"
TELEMT_ALIAS="/bin/tp-native-telemt-${TOKEN,,}"
USER_CREATED=0
GROUP_CREATED=0
UNITS_CREATED=0
SUDOERS_CREATED=0
TELEMT_CREATED=0
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  if (( result != 0 )); then
    printf 'Native fixture failed (exit %s); last installer output:\n' "$result" >&2
    [[ ! -f $ROOT/installer.log ]] || tail -n 100 "$ROOT/installer.log" >&2
    if (( UNITS_CREATED )); then
      journalctl -u "$PANEL_SERVICE.service" --no-pager -n 60 >&2 || true
    fi
  fi
  # Exact unique names only; do not invoke installer uninstall/purge or wildcard cleanup.
  if (( UNITS_CREATED )); then
    systemctl stop "$PANEL_SERVICE.service" "$TELEMT_SERVICE.service" || true
    rm -f -- "$PANEL_UNIT" "$TELEMT_UNIT"
    systemctl daemon-reload || true
    systemctl reset-failed "$PANEL_SERVICE.service" "$TELEMT_SERVICE.service" 2>/dev/null || true
  fi
  if (( SUDOERS_CREATED )); then rm -f -- "$SUDOERS"; fi
  # The default paths were absent before this test. Still require our release
  # bytes and exact fixture bindings before deleting privileged global files.
  if [[ -f $HELPER && ! -L $HELPER ]] && cmp -s "$ROOT/releases/candidate" "$HELPER"; then
    rm -f -- "$HELPER"
  fi
  if [[ -f $POLICY && ! -L $POLICY ]] && python3 - "$POLICY" "$ROOT" "$TELEMT_BIN" <<'PY'
import json, os, sys
path, root, telemt = sys.argv[1:]
try:
    policy = json.load(open(path))
    assert os.stat(path).st_uid == 0
    assert policy['binaries'] == {'panel': root + '/panel-bin/telemt-panel', 'telemt': telemt}
    assert policy['staging_root'] == root + '/data/staging'
except (OSError, ValueError, KeyError, AssertionError):
    sys.exit(1)
PY
  then
    rm -f -- "$POLICY"
  fi
  rmdir -- "$(dirname "$POLICY")" 2>/dev/null || true
  if (( TELEMT_CREATED )); then
    rm -f -- "$TELEMT_BIN" "$TELEMT_BIN.tmp" "$TELEMT_BIN.bak" "$TELEMT_BIN.bak.tmp"
  fi
  if (( USER_CREATED )); then userdel "$ACCOUNT" || true; fi
  if (( GROUP_CREATED )) && getent group "$ACCOUNT" >/dev/null; then groupdel "$ACCOUNT" || true; fi
  rm -rf -- "$ROOT"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for file in "$PANEL_UNIT" "$TELEMT_UNIT" "$SUDOERS" "$TELEMT_BIN" "$TELEMT_BIN.tmp" "$TELEMT_BIN.bak" "$TELEMT_BIN.bak.tmp"; do
  [[ ! -e $file && ! -L $file ]] || fail "fixture name collision: $file"
done
! getent passwd "$ACCOUNT" >/dev/null || fail 'fixture account already exists'
! getent group "$ACCOUNT" >/dev/null || fail 'fixture group already exists'
groupadd --system "$ACCOUNT"
GROUP_CREATED=1
useradd --system --gid "$ACCOUNT" --no-create-home --home-dir "$ROOT/data" --shell /usr/sbin/nologin "$ACCOUNT"
USER_CREATED=1
SERVICE_UID=$(id -u "$ACCOUNT")
[[ $SERVICE_UID != 0 ]] || fail 'fixture account must be unprivileged'

BIN_DIR="$ROOT/panel-bin"
PANEL_BIN="$BIN_DIR/telemt-panel"
CONFIG_DIR="$ROOT/config"
CONFIG_FILE="$CONFIG_DIR/config.toml"
DATA_DIR="$ROOT/data"
install -d -m 0755 "$BIN_DIR" "$ROOT/releases"
install -d -m 0750 -o "$ACCOUNT" -g "$ACCOUNT" "$CONFIG_DIR" "$DATA_DIR"
install -m 0755 "$TP_TEST_BINARY" "$ROOT/releases/candidate"
install -m 0755 "$TP_TEST_RC2_BINARY" "$ROOT/releases/rc2"
install -m 0755 "$ROOT/releases/rc2" "$PANEL_BIN"
TELEMT_CREATED=1
printf '#!/bin/sh\nprintf "telemt fixture 0.0.0\\n"\n' >"$TELEMT_BIN"
chmod 0755 "$TELEMT_BIN"
PORT=$(python3 - <<'PY'
import socket
with socket.socket() as s:
    s.bind(('127.0.0.1', 0))
    print(s.getsockname()[1])
PY
)
BASE_URL="http://127.0.0.1:$PORT"
PASSWORD=$(python3 - <<'PY'
import secrets
print(secrets.token_hex(24))
PY
)
PASSWORD_HASH=$(printf '%s\n' "$PASSWORD" | "$ROOT/releases/candidate" hash-password)
printf '%s' "$PASSWORD" | python3 -c 'import json, sys
with open(sys.argv[1], "w") as f:
    json.dump({"username": "native-admin", "password": sys.stdin.read()}, f)' "$ROOT/login.json"
unset PASSWORD
chmod 0600 "$ROOT/login.json"
cat >"$CONFIG_FILE" <<EOF
listen = "127.0.0.1:$PORT"
data_dir = "$DATA_DIR"
[tls]
mode = "http"
[telemt]
url = "http://127.0.0.1:1"
[auth]
username = "native-admin"
password_hash = "$PASSWORD_HASH"
[store]
driver = "memory"
[host]
service_manager = "systemd"
log_source = "auto"
panel_service = "$PANEL_SERVICE"
telemt_service = "$TELEMT_SERVICE"
[privileges]
mode = "auto"
[updates]
panel_binary_path = "$PANEL_BIN"
telemt_binary_path = "$TELEMT_ALIAS"
EOF
chown "$ACCOUNT:$ACCOUNT" "$CONFIG_FILE"
chmod 0600 "$CONFIG_FILE"
"$ROOT/releases/rc2" config check --format current --config "$CONFIG_FILE"
"$ROOT/releases/candidate" config check --format current --config "$CONFIG_FILE"
cp "$CONFIG_FILE" "$ROOT/rc2-config.toml"
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
Description=Disposable Telemt panel native upgrade fixture
[Service]
Type=simple
User=$ACCOUNT
Group=$ACCOUNT
WorkingDirectory=$DATA_DIR
ExecStartPre=+$ROOT/fail-start-once
ExecStart=$PANEL_BIN --config $CONFIG_FILE
Restart=no
EOF
cat >"$TELEMT_UNIT" <<EOF
[Unit]
Description=Disposable Telemt service control fixture
[Service]
Type=oneshot
ExecStart=/usr/bin/true
RemainAfterExit=yes
EOF

CP=$(command -v cp)
CHMOD=$(command -v chmod)
MV=$(command -v mv)
SYSTEMCTL=$(command -v systemctl)
# Published v1.0.0-rc.2's exact fixed-path cp/chmod/mv sudoers contract.
legacy_sudoers() {
  local target binary
  for target in telemt panel; do
    if [[ $target == panel ]]; then binary=$PANEL_BIN; else binary=$TELEMT_ALIAS; fi
    cat <<EOF
$ACCOUNT ALL=(root) NOPASSWD: $CP -f $DATA_DIR/staging/runs/$target/backup $binary.bak.tmp
$ACCOUNT ALL=(root) NOPASSWD: $CHMOD 0755 $binary.bak.tmp
$ACCOUNT ALL=(root) NOPASSWD: $MV -f $binary.bak.tmp $binary.bak
$ACCOUNT ALL=(root) NOPASSWD: $CP -f $DATA_DIR/staging/runs/$target/bin $binary.tmp
$ACCOUNT ALL=(root) NOPASSWD: $CP -f $binary.bak $binary.tmp
$ACCOUNT ALL=(root) NOPASSWD: $CHMOD 0755 $binary.tmp
$ACCOUNT ALL=(root) NOPASSWD: $MV -f $binary.tmp $binary
EOF
  done
  printf '%s ALL=(root) NOPASSWD: %s restart %s\n' "$ACCOUNT" "$SYSTEMCTL" "$TELEMT_SERVICE"
  printf '%s ALL=(root) NOPASSWD: %s restart %s\n' "$ACCOUNT" "$SYSTEMCTL" "$PANEL_SERVICE"
  printf '%s ALL=(root) NOPASSWD: %s start %s\n' "$ACCOUNT" "$SYSTEMCTL" "$TELEMT_SERVICE"
  printf '%s ALL=(root) NOPASSWD: %s stop %s\n' "$ACCOUNT" "$SYSTEMCTL" "$TELEMT_SERVICE"
}
SUDOERS_CREATED=1
legacy_sudoers >"$SUDOERS"
chmod 0440 "$SUDOERS"
visudo -cf "$SUDOERS" >/dev/null
as_service() { runuser -u "$ACCOUNT" -- "$@"; }
policy_probe() { as_service sudo -n -l -- "$@" >/dev/null; }
legacy_checks() {
  local target binary
  for target in telemt panel; do
    if [[ $target == panel ]]; then binary=$PANEL_BIN; else binary=$TELEMT_ALIAS; fi
    policy_probe "$CP" -f "$DATA_DIR/staging/runs/$target/backup" "$binary.bak.tmp"
    policy_probe "$CHMOD" 0755 "$binary.bak.tmp"
    policy_probe "$MV" -f "$binary.bak.tmp" "$binary.bak"
    policy_probe "$CP" -f "$DATA_DIR/staging/runs/$target/bin" "$binary.tmp"
    policy_probe "$CP" -f "$binary.bak" "$binary.tmp"
    policy_probe "$CHMOD" 0755 "$binary.tmp"
    policy_probe "$MV" -f "$binary.tmp" "$binary"
  done
  policy_probe "$SYSTEMCTL" restart "$PANEL_SERVICE"
  policy_probe "$SYSTEMCTL" restart "$TELEMT_SERVICE"
  policy_probe "$SYSTEMCTL" start "$TELEMT_SERVICE"
  policy_probe "$SYSTEMCTL" stop "$TELEMT_SERVICE"
  install -d -m 0750 -o "$ACCOUNT" -g "$ACCOUNT" "$DATA_DIR/staging/runs/telemt"
  cp "$TELEMT_BIN" "$DATA_DIR/staging/runs/telemt/backup"
  cp "$TELEMT_BIN" "$DATA_DIR/staging/runs/telemt/bin"
  chown "$ACCOUNT:$ACCOUNT" "$DATA_DIR/staging/runs/telemt/"{backup,bin}
  as_service sudo -n -- "$CP" -f "$DATA_DIR/staging/runs/telemt/backup" "$TELEMT_ALIAS.bak.tmp"
  as_service sudo -n -- "$CHMOD" 0755 "$TELEMT_ALIAS.bak.tmp"
  as_service sudo -n -- "$MV" -f "$TELEMT_ALIAS.bak.tmp" "$TELEMT_ALIAS.bak"
  as_service sudo -n -- "$CP" -f "$DATA_DIR/staging/runs/telemt/bin" "$TELEMT_ALIAS.tmp"
  as_service sudo -n -- "$CHMOD" 0755 "$TELEMT_ALIAS.tmp"
  as_service sudo -n -- "$MV" -f "$TELEMT_ALIAS.tmp" "$TELEMT_ALIAS"
  as_service sudo -n -- "$CP" -f "$TELEMT_ALIAS.bak" "$TELEMT_ALIAS.tmp"
  as_service sudo -n -- "$CHMOD" 0755 "$TELEMT_ALIAS.tmp"
  as_service sudo -n -- "$MV" -f "$TELEMT_ALIAS.tmp" "$TELEMT_ALIAS"
  cmp "$TELEMT_BIN" "$TELEMT_BIN.bak"
}
wait_healthy() {
  local attempt
  for attempt in {1..100}; do
    if curl --silent --fail --max-time 1 "$BASE_URL/api/health" >"$ROOT/health.json"; then return; fi
    sleep 0.2
  done
  fail "panel health did not become available after $attempt attempts"
}
assert_process() {
  local expected=$1 pid
  [[ $(systemctl show "$PANEL_SERVICE" --property=User --value) == "$ACCOUNT" ]] || fail 'unit User changed'
  systemctl is-active --quiet "$PANEL_SERVICE" || fail 'panel unit is not active'
  pid=$(systemctl show "$PANEL_SERVICE" --property=MainPID --value)
  [[ $pid =~ ^[1-9][0-9]*$ ]] || fail 'missing actual service MainPID'
  [[ $(stat -c %u "/proc/$pid") == "$SERVICE_UID" ]] || fail 'panel is not running as the retained account'
  cmp "$expected" "/proc/$pid/exe" || fail 'running executable differs from expected release'
  wait_healthy
}
authenticate_host() {
  curl --silent --show-error --fail --max-time 10 -H 'Content-Type: application/json' \
    --data-binary "@$ROOT/login.json" -c "$ROOT/cookies" "$BASE_URL/api/auth/login" >"$ROOT/login-response.json"
  chmod 0600 "$ROOT/cookies"
  curl --silent --show-error --fail --max-time 10 -b "$ROOT/cookies" "$BASE_URL/api/host" >"$ROOT/host.json"
}
systemctl daemon-reload
legacy_checks
systemctl start "$TELEMT_SERVICE" "$PANEL_SERVICE"
assert_process "$ROOT/releases/rc2"
authenticate_host
python3 - "$ROOT/host.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
assert data['privileges_mode'] == 'sudo', data
assert data['caps']['self_update'], data
PY
printf 'PASS native fixture: published RC2 running as UID %s with working legacy exact sudoers\n' "$SERVICE_UID"

export FIXTURE_ROOT="$ROOT" FIXTURE_ACCOUNT="$ACCOUNT" FIXTURE_SERVICE="$PANEL_SERVICE"
export FIXTURE_TELEMT_SERVICE="$TELEMT_SERVICE" FIXTURE_SUDOERS="$SUDOERS" FIXTURE_INSTALLER="$INSTALLER"
run_installer() {
  # Only layout globals change. The actual CLI, parser, rollback trap, sudo and
  # systemctl remain production code; TP_SOURCED avoids touching default paths.
  bash -c '
    set -eu
    TP_SOURCED=1
    . "$FIXTURE_INSTALLER"
    BIN_DIR="$FIXTURE_ROOT/panel-bin"
    PANEL_BIN="$BIN_DIR/telemt-panel"
    SYSTEM_USER="$FIXTURE_ACCOUNT"
    SERVICE_NAME="$FIXTURE_SERVICE"
    TELEMT_SVC="$FIXTURE_TELEMT_SERVICE"
    CONFIG_DIR="$FIXTURE_ROOT/config"
    CONFIG_FILE="$CONFIG_DIR/config.toml"
    DATA_DIR="$FIXTURE_ROOT/data"
    SUDOERS_FILE="$FIXTURE_SUDOERS"
    TELEMT_CONFIG="$FIXTURE_ROOT/unused-telemt.toml"
    LOG_FILE="$FIXTURE_ROOT/panel.log"
    main "$@"
  ' native-installer "$@" >"$ROOT/installer.log" 2>&1
}
UNIT_HASH=$(sha256sum "$PANEL_UNIT")
RC2_CONFIG_HASH=$(sha256sum "$CONFIG_FILE")
RC2_SUDOERS_HASH=$(sha256sum "$SUDOERS")
touch "$ROOT/fail-next-start"
chmod 0600 "$ROOT/fail-next-start"
if run_installer --yes --lang en --binary "$ROOT/releases/candidate"; then
  fail 'installer accepted a candidate whose actual systemd restart failed'
fi
[[ ! -e $ROOT/fail-next-start ]] || fail 'failure fixture did not reach the actual service restart'
[[ $(sha256sum "$CONFIG_FILE") == "$RC2_CONFIG_HASH" ]] || fail 'failed migration did not restore exact RC2 config'
[[ $(sha256sum "$SUDOERS") == "$RC2_SUDOERS_HASH" ]] || fail 'failed migration did not restore exact RC2 sudoers'
[[ ! -e $HELPER && ! -e $POLICY ]] || fail 'failed migration left candidate privilege files installed'
[[ $(sha256sum "$PANEL_UNIT") == "$UNIT_HASH" ]] || fail 'failed update changed retained service unit'
assert_process "$ROOT/releases/rc2"
authenticate_host
python3 - "$ROOT/host.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
assert data['privileges_mode'] == 'sudo' and data['caps']['self_update'], data
PY
printf 'PASS native rollback: real candidate restart failure restored running RC2, config and legacy sudoers\n'
run_installer --yes --lang en --binary "$ROOT/releases/candidate"
[[ $(sha256sum "$PANEL_UNIT") == "$UNIT_HASH" ]] || fail 'regular update changed the retained unit'
assert_process "$ROOT/releases/candidate"
[[ $("$PANEL_BIN" version) == "$CANDIDATE_VERSION" ]] || fail 'installed version is not the candidate'
[[ -f $HELPER && -f $POLICY ]] || fail 'ordinary update did not provision stable helper and policy'

verify_migrated() {
  local target operation action
  "$ROOT/releases/candidate" config inspect --config "$CONFIG_FILE" >"$ROOT/inspect.json"
  as_service sudo -n -- "$HELPER" privileged --policy "$POLICY" inspect >"$ROOT/policy-inspect.json"
  python3 - "$ROOT" "$SERVICE_UID" "$HELPER" "$POLICY" "$TELEMT_BIN" <<'PY'
import json, os, stat, sys, tomllib
root, uid, helper, policy_path, telemt = sys.argv[1:]
with open(root + '/config/config.toml', 'rb') as f:
    cfg = tomllib.load(f)
with open(root + '/rc2-config.toml', 'rb') as f:
    original = tomllib.load(f)
with open(root + '/policy-inspect.json') as f:
    policy = json.load(f)
with open(root + '/inspect.json') as f:
    effective = json.load(f)
expected = {'panel': root + '/panel-bin/telemt-panel', 'telemt': telemt}
assert policy['version'] == 2, policy
assert policy['binaries'] == expected, policy
assert policy['staging_root'] == root + '/data/staging', policy
assert policy['helper_path'] == helper, policy
assert cfg['updates']['panel_binary_path'] == expected['panel'], cfg['updates']
assert cfg['updates']['telemt_binary_path'] == expected['telemt'], cfg['updates']
original['updates']['telemt_binary_path'] = expected['telemt']
assert cfg == original, 'migration must preserve every setting except the canonical Telemt path'
assert effective['privileges_helper_path'] == policy['helper_path'], effective
assert effective['privileges_policy_path'] == policy_path, effective
assert cfg['privileges'].get('helper_path', helper) == effective['privileges_helper_path'], cfg['privileges']
assert cfg['privileges'].get('policy_path', policy_path) == effective['privileges_policy_path'], cfg['privileges']
assert cfg['data_dir'] == root + '/data', cfg['data_dir']
assert cfg['auth']['username'] == 'native-admin', cfg['auth']['username']
assert os.stat(root + '/config/config.toml').st_uid == int(uid)
for path, exact_mode in [(policy['helper_path'], 0o755), (effective['privileges_policy_path'], 0o600)]:
    st = os.lstat(path)
    assert stat.S_ISREG(st.st_mode) and st.st_uid == 0, path
    assert stat.S_IMODE(st.st_mode) == exact_mode, (path, oct(st.st_mode))
    parent = os.path.dirname(path)
    while parent != '/':
        st = os.lstat(parent)
        assert stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o022, parent
        parent = os.path.dirname(parent)
PY
  cmp "$ROOT/releases/candidate" "$HELPER"
  [[ $(stat -c '%u:%a' "$SUDOERS") == 0:440 ]] || fail 'sudoers is not protected'
  visudo -cf "$SUDOERS" >/dev/null
  if grep -Eq 'NOPASSWD: .* (cp|chmod|mv) |NOPASSWD: .*/(cp|chmod|mv) ' "$SUDOERS"; then
    fail 'migration retained the obsolete staged-file sudoers contract'
  fi
  policy_probe "$HELPER" privileged --policy "$POLICY" inspect
  for target in telemt panel; do
    for operation in install backup restore; do
      policy_probe "$HELPER" privileged --policy "$POLICY" "$operation" "$target"
    done
  done
  policy_probe "$SYSTEMCTL" restart "$PANEL_SERVICE"
  policy_probe "$SYSTEMCTL" restart "$TELEMT_SERVICE"
  for action in start stop; do policy_probe "$SYSTEMCTL" "$action" "$TELEMT_SERVICE"; done
  authenticate_host
  python3 - "$ROOT/host.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
assert data['service_manager'] == 'systemd' and data['privileges_mode'] == 'sudo', data
for cap in ['self_update', 'restart_panel', 'restart_telemt', 'start_telemt', 'stop_telemt']:
    assert data['caps'][cap], (cap, data)
PY
}
verify_migrated
printf 'PASS native RC2 -> candidate: one regular installer update canonicalized alias and restored authenticated sudo capabilities\n'

# A candidate already installed by an old updater still has old sudoers and no
# stable helper. The disposable-runner guard reserves the default protected paths.
systemctl stop "$PANEL_SERVICE"
python3 - "$CONFIG_FILE" "$TELEMT_ALIAS" <<'PY'
import re, sys
path, alias = sys.argv[1:]
text = open(path).read()
text, count = re.subn(r'(?m)^telemt_binary_path\s*=.*$', 'telemt_binary_path = "' + alias + '"', text)
assert count == 1, 'one Telemt binary binding expected'
with open(path, 'w') as f:
    f.write(text)
PY
rm -f -- "$HELPER" "$POLICY"
legacy_sudoers >"$SUDOERS"
chmod 0440 "$SUDOERS"
systemctl start "$PANEL_SERVICE"
assert_process "$ROOT/releases/candidate"
authenticate_host
python3 - "$ROOT/host.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
assert data['privileges_mode'] == 'manual' and not data['caps']['self_update'], data
PY
run_installer --yes --lang en repair-privileges --user "$ACCOUNT"
[[ $(sha256sum "$PANEL_UNIT") == "$UNIT_HASH" ]] || fail 'repair changed retained service definition'
assert_process "$ROOT/releases/candidate"
verify_migrated
printf 'PASS native repair-only: installed candidate with parent alias and legacy policy regained sudo capabilities\n'
