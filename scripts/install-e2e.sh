#!/bin/sh
# End-to-end tests for install.sh without root or Docker: each scenario runs
# in an unprivileged user namespace where /etc, /usr, /var and /run are
# overlay-mounted, so the installer really creates users, writes configs,
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
SCENARIOS="${1:-systemd openrc procd sysvinit migrate}"

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

  rc=0
  for sc in $SCENARIOS; do
    echo "=== scenario: $sc ==="
    if E2E_INNER="$sc" E2E_BIN="$BIN" unshare -Urm sh "$0"; then
      echo "=== $sc: PASS"
    else
      echo "=== $sc: FAIL"
      rc=1
    fi
  done
  exit $rc
fi

# ── Inner: runs as uid 0 inside the namespace ────────────────────────────────
SC="$E2E_INNER"
BIN="$E2E_BIN"
WORK=$(mktemp -d)
FAILED=0

fail() { printf 'FAIL %s\n' "$*" >&2; FAILED=$((FAILED + 1)); }
check() { if "$@"; then :; else fail "$*"; fi; }

overlay() {
  mkdir -p "$WORK/ov$1/up" "$WORK/ov$1/work"
  mount -t overlay overlay -o "lowerdir=$1,upperdir=$WORK/ov$1/up,workdir=$WORK/ov$1/work" "$1"
}
# Inside the namespace only the overlay's own root directory is freely
# writable (lower directories keep their unmapped owner), so overlays sit
# exactly on the directories the installer creates files in; /run becomes a
# fresh tmpfs (the installer only probes it for init-system markers).
for d in /etc /usr/local/bin /usr/bin; do overlay "$d"; done
mount -t tmpfs tmpfs /run
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
  cp "$f" "$WORK/$(basename "$f")"
  mount --bind "$WORK/$(basename "$f")" "$f"
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
  sysvinit) STUB_SVC="update-rc.d" ;;
esac
for c in $STUB_SVC; do
  cat >"$STUB/$c" <<EOF
#!/bin/sh
echo "$c \$*" >>"$CALLS"
exit 0
EOF
  chmod 0755 "$STUB/$c"
done
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
    # /etc/rc.common is what procd init scripts source; enable/restart are no-ops here.
    cat >/etc/rc.common <<'EOF'
#!/bin/sh
echo "rc.common $1 $2" >>"$E2E_CALLS"
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
case "$SC" in procd) PANEL_BIN=/usr/bin/telemt-panel ;; *) PANEL_BIN=/usr/local/bin/telemt-panel ;; esac

run_installer() {
  TP_ADMIN_PASSWORD="e2e-password" TP_LISTEN="127.0.0.1:$PORT" TP_LANG=en \
    sh "$SRC/install.sh" --yes --no-start --no-color --binary "$BIN" "$@"
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
fi

echo "--- install"
run_installer install >"$WORK/install.log" 2>&1 || { cat "$WORK/install.log"; fail "install exited non-zero"; }
grep -q '^\[fail\]' "$WORK/install.log" && { cat "$WORK/install.log"; fail "install reported a failure"; }

check test -x "$PANEL_BIN"
check test -f "$CONFIG"
check test "$(stat -c %a "$CONFIG")" = 600
check test -f /etc/telemt-panel/../telemt-panel/config.toml
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
    check grep -q '^data_dir = "/tmp/telemt-panel"' "$CONFIG"
    check test ! -f /etc/sudoers.d/telemt-panel ;;
  sysvinit)
    check test -x /etc/init.d/telemt-panel
    check grep -q 'update-rc.d telemt-panel defaults' "$CALLS"
    check grep -q '/etc/init.d/telemt restart$' /etc/sudoers.d/telemt-panel
    check sh -n /etc/init.d/telemt-panel ;;
  migrate)
    check test -f /etc/systemd/system/telemt-panel.service
    check grep -q 'Config converted to the 1.x format' "$WORK/install.log"
    check grep -q 'auth.jwt_secret' "$WORK/install.log"
    check test "$(find /etc/telemt-panel -name 'config.toml.0x-*' | wc -l)" = 1
    check grep -q '^jwt_secret = "legacy"' /etc/telemt-panel/config.toml.0x-*
    check grep -q '^username = "olduser"' "$CONFIG"
    check grep -q '^telemt_binary_path = "/usr/local/bin/telemt"' "$CONFIG"
    check grep -q '^session_ttl = "24h"' "$CONFIG"
    check grep -q '^secret = "' "$CONFIG"
    check test ! "$(grep -c jwt_secret "$CONFIG")" -gt 0
    check grep -q 'cp -f' /etc/sudoers.d/telemt-panel ;;
esac

echo "--- start the installed binary with the generated config"
sed -i 's#^data_dir = .*#data_dir = "/var/lib/telemt-panel"#' "$CONFIG"
"$PANEL_BIN" --config "$CONFIG" >"$WORK/panel.log" 2>&1 &
PANEL_PID=$!
i=0; up=0
while [ "$i" -lt 10 ]; do
  if curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q 200; then up=1; break; fi
  sleep 1; i=$((i + 1))
done
kill "$PANEL_PID" 2>/dev/null || true
if [ "$up" = 1 ]; then echo "panel answered /api/health"; else cat "$WORK/panel.log"; fail "panel did not come up"; fi

if [ "$SC" != "migrate" ]; then
  echo "--- second run = update path (config untouched)"
  before=$(cat "$CONFIG")
  run_installer install >"$WORK/update.log" 2>&1 || { cat "$WORK/update.log"; fail "update exited non-zero"; }
  check grep -q 'Config kept unchanged' "$WORK/update.log"
  check test "$before" = "$(cat "$CONFIG")"
fi

echo "--- uninstall keeps config"
run_installer uninstall >"$WORK/uninstall.log" 2>&1 || { cat "$WORK/uninstall.log"; fail "uninstall exited non-zero"; }
check test ! -e "$PANEL_BIN"
check test ! -e /etc/sudoers.d/telemt-panel
case "$SC" in
  systemd|migrate) check test ! -e /etc/systemd/system/telemt-panel.service ;;
  *) check test ! -e /etc/init.d/telemt-panel ;;
esac
check test -f "$CONFIG"

echo "--- purge removes everything"
run_installer purge >"$WORK/purge.log" 2>&1 || { cat "$WORK/purge.log"; fail "purge exited non-zero"; }
check test ! -e "$CONFIG"
check test -z "$(ls -A /etc/telemt-panel 2>/dev/null)"
check test ! -e /var/lib/telemt-panel
if [ "$SC" != "procd" ]; then
  if grep -q '^telemt-panel:' /etc/passwd; then fail "user still exists after purge"; fi
fi

if [ "$FAILED" -ne 0 ] || [ "${E2E_VERBOSE:-}" = 1 ]; then
  echo "--- install.log"; cat "$WORK/install.log"
  echo "--- calls.log"; cat "$CALLS"
  exit 1
fi
exit 0
