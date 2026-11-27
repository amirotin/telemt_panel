#!/bin/sh
# End-to-end tests for install.sh without root or Docker: each scenario runs
# in an unprivileged user namespace with a disposable chroot where
# every protected directory has namespace uid 0, so the installer really creates users, writes configs,
# sudoers and service files — all of it discarded afterwards. Service
# managers and account tools are stubbed on PATH (they cannot work inside
# the namespace); everything else is the real thing, including starting
# the installed panel binary with the generated config.
#
#   sh scripts/install-e2e.sh              # all scenarios
#   sh scripts/install-e2e.sh openrc       # one scenario
#   TP_TEST_BINARY=./telemt-panel sh scripts/install-e2e.sh
#
# Exits 0 with a SKIP line when the kernel does not allow unprivileged user
# namespaces with overlayfs (the test then simply cannot run here).
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$(cd "$HERE/.." && pwd)
SCENARIOS="${1:-systemd openrc procd procd-custom sysvinit migrate}"

# ── Outer driver ─────────────────────────────────────────────────────────────
if [ "${E2E_INNER:-}" = "" ]; then
  if ! unshare -Urm true 2>/dev/null; then
    echo "SKIP: unprivileged user namespaces are not available"
    exit 0
  fi
  PROBE=$(mktemp -d)
  mkdir -p "$PROBE/up" "$PROBE/work" "$PROBE/low"
  if ! unshare -Urm sh -c "mount -t overlay overlay -o lowerdir=$PROBE/low,upperdir=$PROBE/up,workdir=$PROBE/work $PROBE/low" 2>/dev/null; then
    rm -rf "$PROBE"
    echo "SKIP: overlayfs is not mountable in a user namespace"
    exit 0
  fi
  rm -rf "$PROBE"

  BIN="${TP_TEST_BINARY:-}"
  if [ -z "$BIN" ]; then
    BIN=$(mktemp -d)/telemt-panel
    echo "building panel binary → $BIN"
    (cd "$SRC" && CGO_ENABLED=0 go build -o "$BIN" ./cmd/panel)
  fi
  BIN=$(cd "$(dirname "$BIN")" && pwd)/$(basename "$BIN")

  copy_tool() {
    TOOL_SOURCE=$(command -v "$1" || true)
    case "$TOOL_SOURCE" in /*) ;; *) return 0 ;; esac
    cp -L "$TOOL_SOURCE" "$ROOTFS/bin/$1"
    cp -L "$TOOL_SOURCE" "$ROOTFS/usr/bin/$1"
    ldd "$TOOL_SOURCE" 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i ~ /^\//) print $i}' | while IFS= read -r dependency; do
      mkdir -p "$ROOTFS$(dirname "$dependency")"
      cp -L "$dependency" "$ROOTFS$dependency"
    done
  }
  rc=0
  for sc in $SCENARIOS; do
    echo "=== scenario: $sc ==="
    ROOTFS=$(mktemp -d)
    mkdir -p "$ROOTFS/bin" "$ROOTFS/usr/bin" "$ROOTFS/usr/local/bin" "$ROOTFS/etc" "$ROOTFS/var/lib" "$ROOTFS/var/log" "$ROOTFS/run" "$ROOTFS/tmp" "$ROOTFS/dev" "$ROOTFS/src/scripts"
    chmod 1777 "$ROOTFS/tmp"
    for tool in dirname basename dd tty stty expr du sh bash cp chmod chown mkdir mktemp cat grep awk sed tr sort cut head tail rm mv ln touch rmdir readlink stat sleep kill timeout flock tar install sha256sum id uname date wc find cmp ls sync curl wget getent sudo visudo; do copy_tool "$tool"; done
    case "$sc" in
      procd|procd-custom) head -c 4096 /dev/urandom >"$ROOTFS/dev/urandom" ;;
      *) copy_tool openssl ;;
    esac
    cp "$SRC/install.sh" "$ROOTFS/src/install.sh"
    cp "$0" "$ROOTFS/src/scripts/install-e2e.sh"
    cp "$BIN" "$ROOTFS/tmp/test-panel"
    printf 'root:x:0:0:root:/root:/bin/sh\n' >"$ROOTFS/etc/passwd"
    printf 'root:x:0:\n' >"$ROOTFS/etc/group"
    printf 'passwd: files\ngroup: files\nhosts: files dns\n' >"$ROOTFS/etc/nsswitch.conf"
    printf 'root ALL=(ALL:ALL) ALL\n@includedir /etc/sudoers.d\n' >"$ROOTFS/etc/sudoers"
    chmod 0440 "$ROOTFS/etc/sudoers"
    : >"$ROOTFS/etc/sudo.conf"
    : >"$ROOTFS/dev/null"
    if E2E_ROOTFS=1 E2E_SINGLE_UID=1 E2E_INNER="$sc" E2E_BIN=/tmp/test-panel unshare -Urm chroot "$ROOTFS" /bin/sh /src/scripts/install-e2e.sh; then
      echo "=== $sc: PASS"
    else
      echo "=== $sc: FAIL"
      rc=1
    fi
    rm -rf "$ROOTFS"
  done
  exit $rc
fi

# ── Inner: runs as uid 0 inside the namespace ────────────────────────────────
SC="$E2E_INNER"
CUSTOM_CONFIG=0
if [ "$SC" = procd-custom ]; then SC=procd; CUSTOM_CONFIG=1; fi
BIN="$E2E_BIN"
WORK=$(mktemp -d)
FAILED=0

fail() { printf 'FAIL %s\n' "$*" >&2; FAILED=$((FAILED + 1)); }
check() { if "$@"; then :; else fail "$*"; fi; }

overlay() {
  if [ "${E2E_ROOTFS:-}" = 1 ]; then return 0; fi
  mkdir -p "$WORK/ov$1/up" "$WORK/ov$1/work"
  mount -t overlay overlay -o "lowerdir=$1,upperdir=$WORK/ov$1/up,workdir=$WORK/ov$1/work" "$1"
}
# Inside the namespace only the overlay's own root directory is freely
# writable (lower directories keep their unmapped owner), so overlays sit
# exactly on the directories the installer creates files in; /run becomes a
# fresh tmpfs (the installer only probes it for init-system markers).
for d in /etc /usr/local/bin /usr/bin; do overlay "$d"; done
if [ "${E2E_ROOTFS:-}" != 1 ]; then mount -t tmpfs tmpfs /run; fi
# writable_dir DIR — directories the installer writes into. Ones that
# already exist on the host with an unmapped owner (a real panel install,
# say) are shadowed by a tmpfs so the scenario starts from a clean slate.
writable_dir() {
  mkdir -p "$1" 2>/dev/null || true
  if [ ! -w "$1" ] || { [ "$2" = fresh ] && [ -n "$(find "$1" -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1)" ]; }; then
    mount -t tmpfs tmpfs "$1"
  fi
}
writable_dir /var/lib fresh
writable_dir /var/log fresh
writable_dir /etc/telemt-panel fresh
writable_dir /etc/sudoers.d keep
writable_dir /etc/systemd/system keep
writable_dir /etc/init.d keep
rm -rf /etc/telemt-panel/* /etc/sudoers.d/telemt-panel /etc/systemd/system/telemt-panel.service /etc/init.d/telemt-panel /usr/local/bin/telemt-panel
# Existing root-owned files stay read-only for the namespace's uid 0 even
# through the overlay (their owner is unmapped), so the account databases
# are replaced by writable copies bind-mounted over the originals.
for f in /etc/passwd /etc/group; do
  if [ "${E2E_ROOTFS:-}" != 1 ]; then
    cp "$f" "$WORK/$(basename "$f")"
    mount --bind "$WORK/$(basename "$f")" "$f"
  fi
done

# Stubs: service managers log their calls; account tools edit /etc/passwd
# and /etc/group directly (useradd cannot lock them in a namespace).
STUB="$WORK/stub"
mkdir -p "$STUB"
CALLS="$WORK/calls.log"
: >"$CALLS"
# Only the current scenario's service manager exists on PATH — the
# installer detects OpenRC by the presence of rc-service, for instance.
case "$SC" in
  systemd|migrate) STUB_SVC="systemctl" ;;
  openrc) STUB_SVC="rc-service rc-update" ;;
  procd) STUB_SVC="" ;;
  sysvinit) STUB_SVC="update-rc.d start-stop-daemon" ;;
esac
for c in $STUB_SVC; do
  cat >"$STUB/$c" <<EOF
#!/bin/sh
echo "$c \$*" >>"$CALLS"
exit 0
EOF
  chmod 0755 "$STUB/$c"
done
if [ "$SC" = systemd ]; then
  cat >"$STUB/systemctl" <<EOF
#!/bin/sh
echo "systemctl \$*" >>"$CALLS"
case "\$*" in
  'show --property=FragmentPath '*) printf '/etc/systemd/system/telemt-panel.service\\n' ;;
  'show --property=DynamicUser '*) printf 'no\\n' ;;
  'show --property=User '*) printf 'telemt-panel\\n' ;;
esac
EOF
  chmod 0755 "$STUB/systemctl"
fi
cat >"$STUB/useradd" <<'EOF'
#!/bin/sh
for a in "$@"; do n="$a"; done
printf '%s:x:990:990::/nonexistent:/usr/sbin/nologin\n' "$n" >>/etc/passwd
printf '%s:x:990:\n' "$n" >>/etc/group
EOF
# sed -i would rename over the bind mount, so edits go through a temp file.
cat >"$STUB/usermod" <<'EOF'
#!/bin/sh
# usermod -aG GROUP USER
g="$2"; u="$3"
if grep -q "^$g:.*[:,]$u\(,\|$\)" /etc/group; then exit 0; fi
if grep -q "^$g:[^:]*:[^:]*:$" /etc/group; then
  sed "s/^\($g:[^:]*:[^:]*:\)$/\1$u/" /etc/group >/tmp/group.$$
else
  sed "s/^\($g:[^:]*:[^:]*:.*\)$/\1,$u/" /etc/group >/tmp/group.$$
fi
cat /tmp/group.$$ >/etc/group; rm -f /tmp/group.$$
EOF
cat >"$STUB/userdel" <<'EOF'
#!/bin/sh
sed "/^$1:/d" /etc/passwd >/tmp/passwd.$$; cat /tmp/passwd.$$ >/etc/passwd; rm -f /tmp/passwd.$$
sed "/^$1:/d" /etc/group >/tmp/group.$$; cat /tmp/group.$$ >/etc/group; rm -f /tmp/group.$$
EOF
# chown/install: unmapped uids cannot be assigned inside the namespace, so
# ownership changes become no-ops while modes are still applied.
cat >"$STUB/chown" <<'EOF'
#!/bin/sh
exit 0
EOF
if [ "${E2E_SINGLE_UID:-}" = 1 ]; then
  # This disposable chroot maps only UID 0. Its account and file-ownership
  # fixtures model the service UID; native systemd coverage exercises real sudo.
  cat >"$STUB/sudo" <<'EOF'
#!/bin/sh
if [ "${1:-} ${2:-} ${3:-} ${4:-}" = '-n -u telemt-panel --' ]; then shift 4; exec "$@"; fi
exec /usr/bin/sudo "$@"
EOF
fi
cat >"$STUB/install" <<'EOF'
#!/bin/sh
args=""
skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in
    -o|-g) skip=1 ;;
    *) args="$args \"$a\"" ;;
  esac
done
eval "exec /usr/bin/install $args"
EOF
chmod 0755 "$STUB"/*
PATH="$STUB:$PATH"
export PATH

# Init-system fixtures.
case "$SC" in
  systemd|migrate)
    mkdir -p /run/systemd/system
    getent group systemd-journal >/dev/null 2>&1 || printf 'systemd-journal:x:101:\n' >>/etc/group ;;
  openrc)
    rm -rf /run/systemd; mkdir -p /run/openrc ;;
  procd)
    rm -rf /run/systemd /run/openrc
    printf 'DISTRIB_ID=OpenWrt\n' >/etc/openwrt_release
    # In the live restore case, run the command from the actual generated service.
    cat >/etc/rc.common <<'EOF'
#!/bin/sh
echo "rc.common $1 $2" >>"$E2E_CALLS"
state="/tmp/fixture-running-${1##*/}"
case "$2" in
  start|restart)
    if [ -n "${E2E_PANEL_PIDFILE:-}" ] && [ "$1" = /etc/init.d/telemt-panel ]; then
      procd_open_instance() { :; }
      procd_close_instance() { :; }
      procd_set_param() {
        [ "$1" = command ] || return 0
        shift
        "$@" >"$E2E_PANEL_PIDFILE.log" 2>&1 &
        echo "$!" >"$E2E_PANEL_PIDFILE"
      }
      . "$1"
      start_service || exit 1
    fi
    touch "$state" ;;
  stop) rm -f "$state" ;;
  running) test -e "$state" ;;
esac
EOF
    export E2E_CALLS="$CALLS" ;;
  sysvinit)
    rm -rf /run/systemd /run/openrc /etc/openwrt_release
    mkdir -p /etc/init.d ;;
esac

# A Telemt config to detect values from. A host directory owned by an
# unmapped uid stays off-limits inside the namespace, so it gets a tmpfs.
mkdir -p /etc/telemt 2>/dev/null || true
[ -w /etc/telemt ] || mount -t tmpfs tmpfs /etc/telemt
cat >/etc/telemt/telemt.toml <<'EOF'
[server.api]
enabled = true
listen = "0.0.0.0:19091"
auth_header = "e2e-secret-header"
EOF

case "$SC" in systemd) PORT=18081 ;; openrc) PORT=18082 ;; procd) PORT=18083 ;; sysvinit) PORT=18084 ;; migrate) PORT=18085 ;; esac
CONFIG=/etc/telemt-panel/config.toml
PANEL_CONFIG_DIR=/etc/telemt-panel
PANEL_DATA_DIR=/var/lib/telemt-panel
if [ "$SC" = procd ]; then PANEL_DATA_DIR=/tmp/telemt-panel; fi
if [ "$CUSTOM_CONFIG" = 1 ]; then
  PANEL_CONFIG_DIR=/etc/router-panel
  PANEL_DATA_DIR=/var/lib/router-panel
  CONFIG=/etc/config/panel.toml
  mkdir -p /etc/config /tmp/etc
  chmod 0755 /etc/config
  printf 'keep\n' >/etc/config/unrelated
  mv /etc/telemt/telemt.toml /tmp/etc/telemt.toml
  TP_CONFIG_DIR="$PANEL_CONFIG_DIR"
  TP_CONFIG_FILE="$CONFIG"
  TP_DATA_DIR="$PANEL_DATA_DIR"
  TP_TELEMT_CONFIG=/tmp/etc/telemt.toml
  export TP_CONFIG_DIR TP_CONFIG_FILE TP_DATA_DIR TP_TELEMT_CONFIG
fi
case "$SC" in procd) PANEL_BIN=/usr/bin/telemt-panel ;; *) PANEL_BIN=/usr/local/bin/telemt-panel ;; esac

run_installer() {
  TP_ADMIN_PASSWORD="e2e-password" TP_LISTEN="127.0.0.1:$PORT" TP_LANG=en \
    sh "$SRC/install.sh" --yes --no-start --no-color --variant "${TP_TEST_VARIANT:-full}" --binary "$BIN" "$@"
}

if [ "$SC" = "migrate" ]; then
  mkdir -p /etc/telemt-panel
  cat >"$CONFIG" <<'EOF'
listen = "127.0.0.1:18085"
data_dir = "/var/lib/telemt-panel"

[telemt]
url = "http://127.0.0.1:19091"
auth_header = "e2e-secret-header"
binary_path = "/usr/local/bin/telemt"
service_name = "telemt"

[panel]
binary_path = "/usr/local/bin/telemt-panel"
service_name = "telemt-panel"

[auth]
username = "olduser"
password_hash = "$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
jwt_secret = "legacy"
session_ttl = "24h"
EOF
  printf 'old\n' >/etc/sudoers.d/telemt-panel
  chmod 0600 "$CONFIG"
  mkdir -p "$(dirname "$PANEL_BIN")" /etc/systemd/system
  cp "$BIN" "$PANEL_BIN"
  chmod 0755 "$PANEL_BIN"
  printf '[Service]\nExecStart=%s --config %s\n' "$PANEL_BIN" "$CONFIG" >/etc/systemd/system/telemt-panel.service
  cp "$CONFIG" "$WORK/legacy-original.toml"
fi

echo "--- install"
if [ "$SC" = systemd ] && [ "$(timeout 5 "$BIN" update-worker --protocol 2>/dev/null)" = 1 ]; then
  if TP_OPEN_FIREWALL=invalid run_installer install >"$WORK/firewall-fail.log" 2>&1; then fail "installer accepted invalid firewall mode"; fi
  check test -f /etc/systemd/system/telemt-panel.service
  check test -f /etc/systemd/system/telemt-panel-updater.service
  check test -x "$PANEL_BIN.start"
fi
run_installer install >"$WORK/install.log" 2>&1 || { cat "$WORK/install.log"; fail "install exited non-zero"; }
grep -q '^\[fail\]' "$WORK/install.log" && { cat "$WORK/install.log"; fail "install reported a failure"; }

check test -x "$PANEL_BIN"
check test -f "$CONFIG"
check test "$(stat -c %a "$CONFIG")" = 600
if [ "$SC" != migrate ]; then
  WORKER_INSTALL=0
  if [ "$(timeout 5 "$BIN" update-worker --protocol 2>/dev/null)" = 1 ]; then WORKER_INSTALL=1; fi
  HELPER_PATH=/usr/local/libexec/telemt-panel-privileged
  if [ "$SC" = procd ]; then HELPER_PATH=/usr/libexec/telemt-panel-privileged; fi
  if [ "$WORKER_INSTALL" = 1 ]; then
    check test ! -e "$HELPER_PATH"
    check test ! -e /etc/telemt-panel-privileged
    check test -x "$PANEL_BIN.start"
    if [ "$SC" = procd ]; then
      check test -f "$PANEL_CONFIG_DIR/updater/registration.json"
      check grep -qFx "worker_state_dir = \"$PANEL_CONFIG_DIR/updater\"" "$CONFIG"
    else
      check test -f /var/lib/telemt-panel/updater/registration.json
    fi
    if [ "$SC" = systemd ]; then
      check test -f /etc/systemd/system/telemt-panel-updater.service
    else
      check test -x /etc/init.d/telemt-panel-updater
    fi
  elif [ "$SC" = procd ]; then
    check test ! -e "$HELPER_PATH"
    check test ! -e /etc/telemt-panel-privileged
  else
    check test -x "$HELPER_PATH"
    check test "$(stat -c %u "$HELPER_PATH")" = 0
    check test "$(stat -c %a "$HELPER_PATH")" = 755
    check "$HELPER_PATH" privileged --policy /etc/telemt-panel-privileged/policy.json inspect
  fi
fi
case "$SC" in
  systemd)
    check test -f /etc/systemd/system/telemt-panel.service
    check grep -q 'systemctl daemon-reload' "$CALLS"
    check grep -q 'systemctl enable telemt-panel' "$CALLS"
    check grep -q '^User=telemt-panel' /etc/systemd/system/telemt-panel.service
    check test -f /etc/sudoers.d/telemt-panel
    check grep -q '^telemt-panel:' /etc/passwd
    check grep -q '^systemd-journal:.*telemt-panel' /etc/group
    check grep -q 'systemctl restart telemt-panel$' /etc/sudoers.d/telemt-panel
    check grep -q '^mode = "sudo"' "$CONFIG"
    if command -v visudo >/dev/null 2>&1; then
      visudo -cf /etc/sudoers.d/telemt-panel >/dev/null 2>&1 || fail "visudo rejects sudoers"
    fi
    check grep -q '^auth_header = "e2e-secret-header"' "$CONFIG"
    check grep -q '^url = "http://127.0.0.1:19091"' "$CONFIG" ;;
  openrc)
    check test -x /etc/init.d/telemt-panel
    check grep -q '^#!/sbin/openrc-run' /etc/init.d/telemt-panel
    check grep -q 'rc-update add telemt-panel default' "$CALLS"
    check grep -q 'rc-service telemt restart$' /etc/sudoers.d/telemt-panel
    check test -f /var/log/telemt-panel.log ;;
  procd)
    check test -x /etc/init.d/telemt-panel
    check grep -q 'rc.common /etc/init.d/telemt-panel enable' "$CALLS"
    check grep -q '^mode = "direct"' "$CONFIG"
    check grep -qFx "data_dir = \"$PANEL_DATA_DIR\"" "$CONFIG"
    check grep -Eq '^secret = "[a-f0-9]{64}"$' "$CONFIG"
    check grep -qF -- "--config $CONFIG" /etc/init.d/telemt-panel
    check test ! -f /etc/sudoers.d/telemt-panel ;;
  sysvinit)
    check test -x /etc/init.d/telemt-panel
    check grep -q 'update-rc.d telemt-panel defaults' "$CALLS"
    check grep -q '/etc/init.d/telemt restart$' /etc/sudoers.d/telemt-panel
    check sh -n /etc/init.d/telemt-panel ;;
  migrate)
    check test -f /etc/systemd/system/telemt-panel.service
    check grep -q 'The 0.6 config stays unchanged' "$WORK/install.log"
    check cmp "$CONFIG" "$WORK/legacy-original.toml"
    check test "$(find /usr/local/bin -name '.telemt-panel-backup.*' | wc -l)" = 1
    check grep -q '^username = "olduser"' "$CONFIG"
    check grep -q '^binary_path = "/usr/local/bin/telemt"' "$CONFIG"
    check grep -q '^session_ttl = "24h"' "$CONFIG"
    check grep -q '^jwt_secret = "legacy"' "$CONFIG"
    check grep -q '^old$' /etc/sudoers.d/telemt-panel ;;
esac

BASE_URL="http://127.0.0.1:$PORT"
start_panel() {
  "$1" --config "$CONFIG" >"$WORK/panel.log" 2>&1 &
  PANEL_PID=$!
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if kill -0 "$PANEL_PID" 2>/dev/null && curl -fsS "$BASE_URL/api/health" >/dev/null 2>&1; then
      echo "panel answered /api/health"
      return 0
    fi
    if [ "$attempt" != 10 ]; then sleep 1; fi
  done
  cat "$WORK/panel.log"; fail "panel did not come up"; return 1
}
stop_panel() {
  kill "$PANEL_PID" 2>/dev/null || true
  wait "$PANEL_PID" || true
}
login_panel() {
  curl -fsS -H 'Content-Type: application/json' --data-binary '{"username":"admin","password":"e2e-password"}' \
    -c "$WORK/cookies" "$BASE_URL/api/auth/login" >"$WORK/login-response.json"
}

echo "--- start the installed binary with the generated config"
if [ "${WORKER_INSTALL:-0}" != 1 ]; then
  sed -i 's#^data_dir = .*#data_dir = "/var/lib/telemt-panel"#' "$CONFIG"
  PANEL_DATA_DIR=/var/lib/telemt-panel
fi
if start_panel "$PANEL_BIN" && [ "$SC" != migrate ]; then
  login_panel || fail "initial login failed"
  check curl -fsS -X PUT -H "Origin: $BASE_URL" -H 'Content-Type: application/json' \
    -b "$WORK/cookies" --data-binary '{"allow_address_override":true}' "$BASE_URL/api/settings/links" >/dev/null
  if [ "$SC" = procd ]; then
    check curl -fsS -b "$WORK/cookies" "$BASE_URL/api/host" >"$WORK/host.json"
    check grep -Eq '"privileges_mode"[[:space:]]*:[[:space:]]*"direct"' "$WORK/host.json"
    check grep -Eq '"self_update"[[:space:]]*:[[:space:]]*true' "$WORK/host.json"
  fi
fi
stop_panel

if [ "$SC" != "migrate" ]; then
  echo "--- second run = update path (config untouched)"
  before=$(cat "$CONFIG")
  if [ "$CUSTOM_CONFIG" = 1 ]; then
    if TP_CONFIG_FILE=/etc/config/incorrect.toml run_installer install >"$WORK/wrong-config.log" 2>&1; then
      fail 'an alternate missing config was treated as a fresh installation'
    fi
    check grep -qF 'from the existing service command' "$WORK/wrong-config.log"
    if TP_CONFIG_DIR='' TP_CONFIG_FILE='' run_installer install >"$WORK/no-overrides.log" 2>&1; then
      fail 'omitting the config overrides allowed replacing an existing OpenWrt service'
    fi
    check grep -qF 'from the existing service command' "$WORK/no-overrides.log"
    check test ! -e /etc/config/incorrect.toml
    check test ! -e /etc/telemt-panel/config.toml
    check grep -qF 'OpenWrt: to keep the config across sysupgrade, add /etc/config/panel.toml' "$WORK/install.log"
    check grep -qFx 'url = "http://127.0.0.1:19091"' "$CONFIG"
    check grep -qFx 'auth_header = "e2e-secret-header"' "$CONFIG"
  fi
  if [ "$SC" != procd ] && [ "$WORKER_INSTALL" != 1 ]; then
    helper_before=$(sha256sum "$HELPER_PATH" | awk '{print $1}')
    helper_inode_before=$(stat -c '%d:%i:%Y:%a' "$HELPER_PATH")
  fi
  run_installer install >"$WORK/update.log" 2>&1 || { cat "$WORK/update.log"; fail "update exited non-zero"; }
  check grep -q 'The binary will be updated' "$WORK/update.log"
  check test "$before" = "$(cat "$CONFIG")"
  if [ "$WORKER_INSTALL" = 1 ]; then
    check test ! -e "$HELPER_PATH"
    check test -x "$PANEL_BIN.start"
  elif [ "$SC" = procd ]; then
    check test ! -e "$HELPER_PATH"
    check test ! -e /etc/telemt-panel-privileged
    check test ! -e /etc/sudoers.d/telemt-panel
  else
    check test "$helper_before" = "$(sha256sum "$HELPER_PATH" | awk '{print $1}')"
    check test "$helper_inode_before" = "$(stat -c '%d:%i:%Y:%a' "$HELPER_PATH")"
  fi
  if [ "$SC" != procd ] && [ "$WORKER_INSTALL" != 1 ]; then
    echo "--- explicit stopped-runtime privilege repair"
    run_installer repair-privileges --user telemt-panel >"$WORK/repair.log" 2>&1 || { cat "$WORK/repair.log"; fail "privilege repair exited non-zero"; }
    check "$HELPER_PATH" privileged --policy /etc/telemt-panel-privileged/policy.json inspect
    check test "$before" = "$(cat "$CONFIG")"
    check grep -q "$HELPER_PATH privileged --policy" /etc/sudoers.d/telemt-panel
    if grep -q "$PANEL_BIN privileged --policy" /etc/sudoers.d/telemt-panel; then fail "replaceable panel retains privileged grants"; fi
  fi
fi

RECEIPT=/etc/telemt-panel-reinstall
SERVICE=/etc/init.d/telemt-panel
UPDATER=/etc/init.d/telemt-panel-updater
REGISTRATION="$PANEL_DATA_DIR/updater/registration.json"
case "$SC" in
  systemd|migrate)
    SERVICE=/etc/systemd/system/telemt-panel.service
    UPDATER=/etc/systemd/system/telemt-panel-updater.service ;;
  procd) REGISTRATION="$PANEL_CONFIG_DIR/updater/registration.json" ;;
esac
if [ "$SC" != migrate ]; then
  cp "$CONFIG" "$WORK/original.toml"
  printf 'retained data\n' >"$PANEL_DATA_DIR/retained-data"
  if [ "$SC" != procd ]; then cp /etc/sudoers.d/telemt-panel "$WORK/original.sudoers"; fi
  if [ "$SC" = systemd ]; then
    printf '\n[Service]\nEnvironment=PANEL_OPERATOR_SETTING=kept\n' >>"$SERVICE"
  fi
fi

echo "--- uninstall keeps config"
if [ "$SC" = sysvinit ]; then
  mkdir -p /etc/rc2.d /etc/rc5.d
  ln -s "$SERVICE" /etc/rc2.d/S42telemt-panel
  ln -s "$SERVICE" /etc/rc5.d/K17telemt-panel
fi
if [ "$SC" = procd ] && [ "$CUSTOM_CONFIG" = 0 ] && [ "$WORKER_INSTALL" = 1 ]; then
  exec 8>"${REGISTRATION%/*}/operation.lock"
  flock -n 8 || exit 1
  if run_installer uninstall >"$WORK/busy-uninstall.log" 2>&1; then fail "uninstall interrupted an active worker"; fi
  if run_installer purge >"$WORK/busy-purge.log" 2>&1; then fail "purge interrupted an active worker"; fi
  check test -x "$PANEL_BIN"
  check test -x "$SERVICE"
  check test ! -e "$RECEIPT"
  exec 8>&-
fi
run_installer uninstall >"$WORK/uninstall.log" 2>&1 || { cat "$WORK/uninstall.log"; fail "uninstall exited non-zero"; }
check test ! -e "$PANEL_BIN"
check test ! -e "$PANEL_BIN.start"
check test ! -e /etc/sudoers.d/telemt-panel
check test ! -e "$SERVICE"
check test ! -e "$UPDATER"
check test -f "$CONFIG"
if [ "$SC" = sysvinit ]; then
  check grep -qx /etc/rc2.d/S42telemt-panel "$RECEIPT/runlevel_links"
  check grep -qx /etc/rc5.d/K17telemt-panel "$RECEIPT/runlevel_links"
  # The namespace's init command stub records requests and leaves links in place.
  rm -f /etc/rc2.d/S42telemt-panel /etc/rc5.d/K17telemt-panel
elif [ "$SC" = openrc ]; then
  check test -f "$RECEIPT/runlevel_links"
  check test ! -s "$RECEIPT/runlevel_links"
fi

restore_installer() {
  # Simulate a new shell, with no answers or paths from the original setup.
  restore_file=${1:-}; restore_dir=${2:-}
  if [ -n "${E2E_PANEL_PIDFILE:-}" ]; then set --; else set -- --no-start; fi
  TP_CONFIG_FILE="$restore_file" TP_CONFIG_DIR="$restore_dir" TP_TELEMT_CONFIG='' TP_DATA_DIR='' TP_LANG=en \
    sh "$SRC/install.sh" --yes --binary "$BIN" "$@"
}
check_restored_login() {
  login_panel || fail "original password no longer works"
  check curl -fsS -b "$WORK/cookies" "$BASE_URL/api/settings/links" >"$WORK/restored-setting"
  check grep -Eq '"allow_address_override"[[:space:]]*:[[:space:]]*true' "$WORK/restored-setting"
}
check_restored_panel() {
  check cmp "$WORK/original.toml" "$CONFIG"
  check grep -qx 'retained data' "$PANEL_DATA_DIR/retained-data"
  check test -x "$PANEL_BIN"
  check grep -qF -- "--config $CONFIG" "$SERVICE"
  if [ "$SC" = systemd ]; then
    check grep -qx 'Environment=PANEL_OPERATOR_SETTING=kept' "$SERVICE"
    check grep -qx 'User=telemt-panel' "$SERVICE"
  fi
  if [ "$SC" != procd ]; then
    check cmp "$WORK/original.sudoers" /etc/sudoers.d/telemt-panel
    check test "$(stat -c %a /etc/sudoers.d/telemt-panel)" = 440
  else
    check test ! -e /etc/sudoers.d/telemt-panel
  fi
  installed_command="$PANEL_BIN"
  if [ "$WORKER_INSTALL" = 1 ]; then
    installed_command="$PANEL_BIN.start"
    check test -x "$installed_command"
    check grep -qF "$installed_command" "$SERVICE"
    check grep -qF "$installed_command" "$UPDATER"
    check grep -qF 'telemt-panel-updater' "$REGISTRATION"
    check timeout 15 "$installed_command" --worker
  fi
  if [ -n "${E2E_PANEL_PIDFILE:-}" ]; then
    check grep -Eq '^rc.common /etc/init.d/telemt-panel (start|restart)$' "$CALLS"
    check_restored_login
  else
    if grep -Eq '(^|[[:space:]])(--start|start|restart)([[:space:]]|$)' "$CALLS"; then
      fail "--no-start started a service during reinstall"
    fi
    if start_panel "$installed_command"; then check_restored_login; fi
    stop_panel
  fi
}

if [ "$SC" != migrate ]; then
  if [ "$SC" = procd ] && [ "$CUSTOM_CONFIG" = 0 ]; then
    echo "--- corrupt retained config and incomplete uninstall are refused"
    printf '[broken\n' >"$CONFIG"
    if restore_installer >"$WORK/broken.log" 2>&1; then fail "accepted a corrupt retained config"; fi
    check grep -qFx '[broken' "$CONFIG"
    check test ! -e "$PANEL_BIN"
    cp "$WORK/original.toml" "$CONFIG"
    printf 'operator service\n' >"$SERVICE"
    if restore_installer >"$WORK/partial.log" 2>&1; then fail "overwrote a remaining service"; fi
    check grep -qx 'operator service' "$SERVICE"
    check test ! -e "$PANEL_BIN"
    rm "$SERVICE"
    mkdir "$WORK/fail-link"
    cat >"$WORK/fail-link/ln" <<'EOF'
#!/bin/sh
if [ "${3:-}" = /etc/init.d/telemt-panel ]; then exit 1; fi
exec /bin/ln "$@"
EOF
    chmod 0755 "$WORK/fail-link/ln"
    if PATH="$WORK/fail-link:$PATH" restore_installer >"$WORK/interrupted.log" 2>&1; then fail "accepted failed service publication"; fi
    check test -d "$RECEIPT"
    check test ! -e "$PANEL_BIN"
    check test ! -e "$REGISTRATION"
    check test ! -e "$PANEL_BIN.start"
    check test ! -e "$UPDATER"
    check cmp "$CONFIG" "$WORK/original.toml"
  fi
  echo "--- plain install restores the uninstalled panel"
  check test -d "$RECEIPT"
  check grep -qx "${TP_TEST_VARIANT:-full}" "$RECEIPT/variant"
  : >"$CALLS"
  restore_installer >"$WORK/reinstall.log" 2>&1 || { cat "$WORK/reinstall.log"; exit 1; }
  if [ "$SC" = sysvinit ]; then
    check test /etc/rc2.d/S42telemt-panel -ef "$SERVICE"
    check test /etc/rc5.d/K17telemt-panel -ef "$SERVICE"
  elif [ "$SC" = openrc ] && grep -q '^rc-update add ' "$CALLS"; then
    fail 'reinstall enabled a previously disabled OpenRC service'
  fi
  check_restored_panel
  if [ "$CUSTOM_CONFIG" = 1 ]; then check test ! -e /etc/telemt-panel/config.toml; fi
  if [ "$SC" = procd ]; then
    echo "--- reinstall after an older OpenWrt uninstall without a receipt"
    run_installer uninstall >"$WORK/uninstall-again.log" 2>&1 || { cat "$WORK/uninstall-again.log"; exit 1; }
    mv "$RECEIPT" "$WORK/previous-uninstall"
    : >"$CALLS"
    if [ "$CUSTOM_CONFIG" = 1 ]; then
      restore_installer "$CONFIG" "$PANEL_CONFIG_DIR" >"$WORK/legacy-reinstall.log" 2>&1 || { cat "$WORK/legacy-reinstall.log"; exit 1; }
    else
      E2E_PANEL_PIDFILE="$WORK/restored.pid"
      export E2E_PANEL_PIDFILE
      trap 'if [ -s "$E2E_PANEL_PIDFILE" ]; then kill "$(cat "$E2E_PANEL_PIDFILE")" 2>/dev/null || :; fi' EXIT
      restore_installer >"$WORK/legacy-reinstall.log" 2>&1 || { cat "$WORK/legacy-reinstall.log"; exit 1; }
    fi
    check_restored_panel
    if [ -n "${E2E_PANEL_PIDFILE:-}" ]; then
      kill "$(cat "$E2E_PANEL_PIDFILE")"
      trap - EXIT
      unset E2E_PANEL_PIDFILE
    fi
  fi
  run_installer uninstall >"$WORK/before-purge.log" 2>&1 || { cat "$WORK/before-purge.log"; exit 1; }
  check test -d "$RECEIPT"
fi

echo "--- purge removes everything"
run_installer purge >"$WORK/purge.log" 2>&1 || { cat "$WORK/purge.log"; fail "purge exited non-zero"; }
check test ! -e "$CONFIG"
check test ! -e "$RECEIPT"
check test ! -e "$PANEL_DATA_DIR"
check test -z "$(ls -A "$PANEL_CONFIG_DIR" 2>/dev/null)"
if [ "$CUSTOM_CONFIG" = 1 ]; then
  check test "$(stat -c %a /etc/config)" = 755
  check grep -qFx keep /etc/config/unrelated
  check test -f /tmp/etc/telemt.toml
fi
check test ! -e /var/lib/telemt-panel
# Account ownership beyond this installation is not guessed during purge.

if [ "$FAILED" -ne 0 ] || [ "${E2E_VERBOSE:-}" = 1 ]; then
  echo "--- install.log"; cat "$WORK/install.log"
  echo "--- calls.log"; cat "$CALLS"
  exit 1
fi
exit 0
