#!/bin/sh
# Focused Entware installer fixtures. All generated services and processes live
# below mktemp; this script never touches /opt or host service state.
# Stubs are invoked through the sourced installer.
# shellcheck disable=SC2034,SC2016,SC2317,SC2329
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
DAEMON_PID=""
OTHER_PID=""
cleanup_entware_test() {
  [ -z "$DAEMON_PID" ] || kill "$DAEMON_PID" 2>/dev/null || true
  [ -z "$OTHER_PID" ] || kill "$OTHER_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup_entware_test EXIT INT TERM

TP_SOURCED=1
# shellcheck disable=SC1091
. "$HERE/../install.sh"
L=en
COLOR=0
DRY_RUN=0
SUDO=""

fail() { printf 'FAIL entware: %s\n' "$*" >&2; exit 1; }
assert_eq() { [ "$2" = "$3" ] || fail "$1: expected [$2], got [$3]"; }
assert_contains() { grep -qF -- "$2" "$3" || fail "$1: [$2] not found in $3"; }

# Entware requires both characteristic markers and loses to native OpenWrt.
SYSTEMD_RUN_DIR="$TMP/no-systemd"
OPENRC_RUN_DIR="$TMP/no-openrc"
OPENWRT_RELEASE="$TMP/no-openwrt"
SYSV_INIT_DIR="$TMP/no-sysv"
ENTWARE_RC_UNSLUNG="$TMP/opt/etc/init.d/rc.unslung"
ENTWARE_OPKG="$TMP/opt/bin/opkg"
mkdir -p "$(dirname "$ENTWARE_RC_UNSLUNG")" "$(dirname "$ENTWARE_OPKG")"
printf '#!/bin/sh\n' >"$ENTWARE_RC_UNSLUNG"
printf '#!/bin/sh\n' >"$ENTWARE_OPKG"
chmod 0755 "$ENTWARE_RC_UNSLUNG" "$ENTWARE_OPKG"
has() { return 1; }
detect_init
assert_eq "marker pair selects Entware" entware "$INIT"
printf 'DISTRIB_ID=OpenWrt\n' >"$OPENWRT_RELEASE"
detect_init
assert_eq "native OpenWrt wins over Entware" procd "$INIT"
rm -f "$OPENWRT_RELEASE" "$ENTWARE_RC_UNSLUNG"
detect_init
assert_eq "opkg alone is not Entware" none "$INIT"
has() { command -v "$1" >/dev/null 2>&1; }

mkdir -p "$TMP/binary-dir"
printf '#!/bin/sh\n' >"$TMP/binary-file"
chmod 0755 "$TMP/binary-file" "$TMP/binary-dir"
if telemt_binary_usable "$TMP/binary-file"; then :; else fail "executable Telemt file rejected"; fi
if telemt_binary_usable "$TMP/binary-dir"; then fail "executable directory accepted as Telemt binary"; fi

# Entware receives a persistent /opt layout and standard service names.
INIT=entware
SERVICE_NAME=telemt-panel
TELEMT_SVC=telemt
BIN_DIR=/usr/local/bin
CONFIG_DIR=/etc/telemt-panel
CONFIG_FILE="$CONFIG_DIR/config.toml"
SUDOERS_FILE=/etc/sudoers.d/telemt-panel
DATA_DIR=/var/lib/telemt-panel
LOG_FILE=/var/log/telemt-panel.log
apply_layout
assert_eq "panel service default" S99telemt-panel "$SERVICE_NAME"
assert_eq "Telemt service default" S99telemt "$TELEMT_SVC"
assert_eq "binary path" /opt/bin/telemt-panel "$PANEL_BIN"
assert_eq "config path" /opt/etc/telemt-panel/config.toml "$CONFIG_FILE"
assert_eq "state path" /opt/var/lib/telemt-panel "$DATA_DIR"
assert_eq "log path" /opt/var/log/telemt-panel.log "$LOG_FILE"
assert_eq "sudoers path" /opt/etc/sudoers.d/telemt-panel "$SUDOERS_FILE"
assert_eq "pid path" /opt/var/run/S99telemt-panel.pid "$PID_FILE"
assert_eq "service path" /opt/etc/init.d/S99telemt-panel "$SERVICE_FILE"

# Fresh Entware configs use direct argv arrays for the custom service manager.
TELEMT_URL=http://127.0.0.1:9091
TELEMT_AUTH=''
LISTEN=0.0.0.0:8080
BASE_PATH=''
ADMIN_USER="admin"
PASS_HASH='$2a$10$fixture'
SUBPAGE_ENABLED=no
SUBPAGE_SECRET=fixture
TELEMT_BIN=/opt/bin/telemt
RUN_AS=root
STORE_DRIVER=sqlite
gen_config >"$TMP/config.toml"
assert_contains "custom manager" 'service_manager = "custom"' "$TMP/config.toml"
assert_contains "file log source" 'log_source = "file"' "$TMP/config.toml"
assert_contains "Telemt log remains unconfigured" 'log_file = ""' "$TMP/config.toml"
assert_contains "Telemt log guidance" 'actual Telemt log file' "$TMP/config.toml"
assert_contains "Telemt start argv" 'start = ["/opt/etc/init.d/S99telemt", "start"]' "$TMP/config.toml"
assert_contains "Telemt stop argv" 'stop = ["/opt/etc/init.d/S99telemt", "stop"]' "$TMP/config.toml"
assert_contains "Telemt restart argv" 'restart = ["/opt/etc/init.d/S99telemt", "restart"]' "$TMP/config.toml"
assert_contains "panel restart argv" 'restart = ["/opt/etc/init.d/S99telemt-panel", "restart"]' "$TMP/config.toml"

PANEL_SERVICE_SCRIPT=S99telemt-panel
TELEMT_SERVICE_SCRIPT=S99telemt
resolve_report_service_scripts
assert_eq "reported panel basename is rooted" /opt/etc/init.d/S99telemt-panel "$PANEL_SERVICE_SCRIPT"
assert_eq "reported Telemt basename is rooted" /opt/etc/init.d/S99telemt "$TELEMT_SERVICE_SCRIPT"
PANEL_SERVICE_SCRIPT='../unsafe'
TELEMT_SERVICE_SCRIPT=''
if resolve_report_service_scripts; then fail "unsafe reported service basename accepted"; fi

# Generated service scripts require both the canonical executable and exact
# argv, including the configured config path. The symlinked prefix models /opt
# on Entware systems where /proc/PID/exe resolves through another mount path.
cat >"$TMP/native-fixture.go" <<'EOF'
package main

import (
	"bytes"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"syscall"
)

func main() {
	if path := os.Getenv("FIXTURE_STARTED"); path != "" {
		_ = os.WriteFile(path, []byte(strconv.Itoa(os.Getpid())), 0600)
		_ = os.WriteFile(path+".path", []byte(os.Getenv("PATH")), 0600)
	}
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
	restart := make(chan os.Signal, 1)
	signal.Notify(restart, syscall.SIGUSR1)
	go func() {
		for range restart {
			cmd := exec.Command(os.Getenv("FIXTURE_CONTROL"), "restart")
			cmd.Stdout, cmd.Stderr = &bytes.Buffer{}, &bytes.Buffer{}
			_ = cmd.Run()
		}
	}()
	<-ch
}
EOF
mkdir -p "$TMP/real-opt/bin"
go build -o "$TMP/real-opt/bin/telemt-panel" "$TMP/native-fixture.go"
cp "$TMP/real-opt/bin/telemt-panel" "$TMP/hold-process"
ln -s "$TMP/real-opt" "$TMP/opt-link"
PANEL_BIN="$TMP/opt-link/bin/telemt-panel"
CONFIG_FILE="$TMP/config.toml"
SERVICE_NAME=S99telemt-panel
SERVICE_FILE="$TMP/S99telemt-panel"
PID_FILE="$TMP/run/S99telemt-panel.pid"
LOG_FILE="$TMP/log/telemt-panel.log"
gen_service >"$SERVICE_FILE"
chmod 0755 "$SERVICE_FILE"
assert_contains "managed ownership marker" '# telemt-panel managed Entware service' "$SERVICE_FILE"
sh -n "$SERVICE_FILE" || fail "generated service has syntax errors"
FIXTURE_STARTED="$TMP/service-started"
export FIXTURE_STARTED
FIXTURE_CONTROL="$SERVICE_FILE"
export FIXTURE_CONTROL
if ! PATH=/usr/bin:/bin "$SERVICE_FILE" start; then
  [ ! -f "$LOG_FILE" ] || cat "$LOG_FILE" >&2
  if [ -f "$FIXTURE_STARTED" ]; then
    _debug_pid=$(cat "$FIXTURE_STARTED")
    printf 'DEBUG exe=%s cmdline=' "$(readlink "/proc/$_debug_pid/exe" 2>/dev/null || true)" >&2
    tr '\000' ' ' <"/proc/$_debug_pid/cmdline" >&2 || true
    printf '\n' >&2
    kill "$_debug_pid" 2>/dev/null || true
  fi
  fail "service did not accept symlinked daemon identity"
fi
DAEMON_PID=$(cat "$PID_FILE")
assert_eq "boot environment includes Entware utilities" /opt/bin:/opt/sbin:/usr/bin:/usr/sbin:/bin:/sbin "$(cat "$FIXTURE_STARTED.path")"
kill -0 "$DAEMON_PID" 2>/dev/null || fail "service did not start"
"$SERVICE_FILE" status >/dev/null || fail "running service reported stopped"

cp "$TMP/hold-process" "$TMP/new-panel"
mv "$TMP/new-panel" "$TMP/real-opt/bin/telemt-panel"
OLD_PID=$DAEMON_PID
"$SERVICE_FILE" restart
DAEMON_PID=$(cat "$PID_FILE")
[ "$OLD_PID" != "$DAEMON_PID" ] || fail "restart retained old PID"
if kill -0 "$OLD_PID" 2>/dev/null; then fail "self-update restart left old process alive"; fi
kill -0 "$DAEMON_PID" 2>/dev/null || fail "self-update restart did not start replacement"

# A restart launched by the daemon loses its parent and capture pipes when
# stop terminates that daemon. The service must still launch its replacement.
OLD_PID=$DAEMON_PID
kill -USR1 "$OLD_PID"
SELF_RESTART_WAIT=0
while [ "$SELF_RESTART_WAIT" -lt 15 ]; do
  if [ -f "$PID_FILE" ]; then
    DAEMON_PID=$(cat "$PID_FILE")
    if [ "$DAEMON_PID" != "$OLD_PID" ] && "$SERVICE_FILE" status >/dev/null 2>&1; then break; fi
  fi
  sleep 1
  SELF_RESTART_WAIT=$((SELF_RESTART_WAIT + 1))
done
[ "$SELF_RESTART_WAIT" -lt 15 ] || fail "daemon-triggered restart did not start replacement"
"$SERVICE_FILE" stop
DAEMON_PID=""
[ ! -e "$PID_FILE" ] || fail "successful stop retained PID file"

# A forged PID for another executable must be refused even when its command
# line contains the daemon path as an unrelated argument.
unset FIXTURE_STARTED
"$TMP/hold-process" "$PANEL_BIN" --config "$CONFIG_FILE" &
OTHER_PID=$!
mkdir -p "$(dirname "$PID_FILE")"
printf '%s\n' "$OTHER_PID" >"$PID_FILE"
if "$SERVICE_FILE" stop >"$TMP/forged-pid.log" 2>&1; then
  fail "service accepted a forged PID containing the daemon as an argument"
fi
kill -0 "$OTHER_PID" 2>/dev/null || fail "forged-PID process was killed"
kill "$OTHER_PID"
wait "$OTHER_PID" 2>/dev/null || true
OTHER_PID=""

# The same executable under another config is not this service instance.
"$PANEL_BIN" --config "$TMP/other-config.toml" &
OTHER_PID=$!
printf '%s\n' "$OTHER_PID" >"$PID_FILE"
if "$SERVICE_FILE" stop >"$TMP/wrong-config.log" 2>&1; then
  fail "service accepted the same executable with another config"
fi
kill -0 "$OTHER_PID" 2>/dev/null || fail "different-config process was killed"
kill "$OTHER_PID"
wait "$OTHER_PID" 2>/dev/null || true
OTHER_PID=""

# Failure to create the PID file must happen before spawning the daemon.
mkdir -p "$TMP/read-only-run"
chmod 0555 "$TMP/read-only-run"
PID_FILE="$TMP/read-only-run/panel.pid"
SERVICE_FILE="$TMP/S99telemt-panel-bad-pid"
FIXTURE_STARTED="$TMP/bad-pid-started"
export FIXTURE_STARTED
gen_service >"$SERVICE_FILE"
chmod 0755 "$SERVICE_FILE"
if "$SERVICE_FILE" start >"$TMP/bad-pid.log" 2>&1; then
  fail "service started without a writable PID file"
fi
if [ -f "$FIXTURE_STARTED" ]; then
  OTHER_PID=$(cat "$FIXTURE_STARTED")
  kill "$OTHER_PID" 2>/dev/null || true
  wait "$OTHER_PID" 2>/dev/null || true
  fail "PID-file write failure left a daemon process behind"
fi
chmod 0755 "$TMP/read-only-run"
unset FIXTURE_STARTED

SERVICE_FILE="$TMP/S99telemt-panel"
PID_FILE="$TMP/run/S99telemt-panel.pid"

# A colliding user script is never overwritten or treated as installer-owned.
printf '#!/bin/sh\necho user-owned\n' >"$SERVICE_FILE"
chmod 0755 "$SERVICE_FILE"
if entware_service_managed "$SERVICE_FILE"; then fail "user script accepted as managed"; fi
if (
  INIT=entware
  gen_service() { printf 'replacement\n'; }
  run() { fail "service control called for user script"; }
  write_root_file() { cat >"$TMP/unexpected-write"; }
  install_service
) >"$TMP/collision.log" 2>&1; then
  fail "fresh install overwrote an existing Entware script"
fi
[ ! -e "$TMP/unexpected-write" ] || fail "existing service was written before refusal"
assert_contains "manual collision guidance" 'already exists' "$TMP/collision.log"

# Retained nonstandard custom commands restart through the typed CLI argv; an
# exact managed Entware script uses that script directly.
CALLS="$TMP/calls"
run() { printf '%s\n' "$*" >>"$CALLS"; }
SERVICE_MANAGER=custom
PANEL_SERVICE_SCRIPT=''
STAGED_BIN="$TMP/candidate"
UPDATE_SOURCE="$TMP/update.toml"
: >"$UPDATE_SOURCE"
restart_retained_panel
assert_eq "generic custom restart argv" "$STAGED_BIN service restart --target panel --config $UPDATE_SOURCE" "$(cat "$CALLS")"
: >"$CALLS"
PANEL_SERVICE_SCRIPT="$SERVICE_FILE"
printf '# telemt-panel managed Entware service\n' >"$SERVICE_FILE"
restart_retained_panel
assert_eq "managed Entware restart argv" "$SERVICE_FILE restart" "$(cat "$CALLS")"

INIT=systemd
SERVICE_MANAGER=custom
PANEL_SERVICE_SCRIPT="$SERVICE_FILE"
printf '#!/bin/sh\necho user-owned\n' >"$SERVICE_FILE"
validate_retained_service
assert_eq "generic unmanaged script is not invoked directly" '' "$PANEL_SERVICE_SCRIPT"
: >"$CALLS"
restart_retained_panel
assert_eq "generic unmanaged script falls back to typed CLI" "$STAGED_BIN service restart --target panel --config $UPDATE_SOURCE" "$(cat "$CALLS")"

# Removal never guesses a service file for arbitrary custom commands.
REMOVE="$TMP/remove"
mkdir -p "$REMOVE/bin" "$REMOVE/config" "$REMOVE/data" "$REMOVE/telemt"
printf 'panel\n' >"$REMOVE/bin/panel"
printf 'telemt\n' >"$REMOVE/telemt/telemt"
printf 'fixture\n' >"$REMOVE/config/config.toml"
cat >"$REMOVE/parser" <<EOF
#!/bin/sh
case "\$1 \$2" in
  "config inspect")
    printf '%s\\n' '{"panel_binary_path":"$REMOVE/bin/panel","telemt_binary_path":"$REMOVE/telemt/telemt","panel_service":"custom-panel","telemt_service":"custom-telemt","service_manager":"custom","data_dir":"$REMOVE/data"}' ;;
  *) exit 1 ;;
esac
EOF
chmod 0755 "$REMOVE/parser"
"$REMOVE/parser" config inspect --config "$REMOVE/config/config.toml" >"$REMOVE/parser-check" || fail "removal parser fixture failed"
if (
  CMD=uninstall
  CONFIG_DIR="$REMOVE/config"
  CONFIG_FILE="$REMOVE/config/config.toml"
  SUDOERS_FILE="$REMOVE/sudoers"
  TELEMT_CONFIG="$REMOVE/telemt/telemt.toml"
  BINARY_FILE="$REMOVE/parser"
  ASSUME_YES=1
  require_tty() { :; }
  check_prereqs_quiet() { :; }
  detect_init() { INIT=systemd; }
  apply_layout() { PANEL_BIN="$REMOVE/bin/panel"; SERVICE_FILE="$REMOVE/unit"; }
  prepare_removal
) >"$REMOVE/output" 2>&1; then
  fail "unmanaged custom removal was accepted"
fi
[ -f "$REMOVE/bin/panel" ] || fail "unsafe removal deleted panel binary"
grep -qF 'Removal targets failed validation' "$REMOVE/output" || fail "unmanaged removal guidance: $(cat "$REMOVE/output")"

printf 'PASS entware installer fixtures\n'
