#!/bin/sh
# Unit tests for install.sh: sources the installer with TP_SOURCED=1 and
# exercises its pure functions (TOML reader, generators, 0.x migration)
# without touching the host. Runs under dash, bash and busybox sh:
#
#   sh scripts/install-test.sh
#   bash scripts/install-test.sh
# shellcheck disable=SC2034,SC2016  # globals are consumed by the sourced installer
# shellcheck disable=SC2317  # stubs are called by functions from the sourced installer
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
INSTALLER="$HERE/../install.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

# Stub service-manager binaries so restart_cmd resolves absolute paths on
# any test host, whatever init system it really runs.
mkdir -p "$TMP/bin"
for _c in systemctl rc-service; do
  printf '#!/bin/sh\nexit 0\n' >"$TMP/bin/$_c"
  chmod 0755 "$TMP/bin/$_c"
done
PATH="$TMP/bin:$PATH"

TP_SOURCED=1
# shellcheck disable=SC1090
. "$INSTALLER"
L="en"
COLOR=0
DRY_RUN=1
ASSUME_YES=1
ensure_temp_dir

FAILED=0
PASSED=0

fail() {
  printf 'FAIL %s\n' "$*" >&2
  FAILED=$((FAILED + 1))
}

pass() {
  PASSED=$((PASSED + 1))
}

# assert_eq NAME EXPECTED ACTUAL
assert_eq() {
  if [ "$2" = "$3" ]; then
    pass
  else
    fail "$1: expected [$2], got [$3]"
  fi
}

# assert_contains NAME NEEDLE FILE
assert_contains() {
  if grep -qF -- "$2" "$3"; then
    pass
  else
    fail "$1: [$2] not found in $3"
  fi
}

# assert_not_contains NAME NEEDLE FILE
assert_not_contains() {
  if grep -qF -- "$2" "$3"; then
    fail "$1: [$2] unexpectedly found in $3"
  else
    pass
  fi
}

# ── toml_value ───────────────────────────────────────────────────────────────
cat >"$TMP/t.toml" <<'EOF'
# comment
listen = "0.0.0.0:8080"   # trailing comment
data_dir = "/var/lib/x"
plain = 42 # number

[server]
listen = "9.9.9.9:1"

  [server.api]
enabled = true
listen = "127.0.0.1:9091"
auth_header = "Bearer a#b"

[auth]
username = "admin"
EOF
assert_eq "toml top-level" "0.0.0.0:8080" "$(toml_value "$TMP/t.toml" "" listen)"
assert_eq "toml unquoted" "42" "$(toml_value "$TMP/t.toml" "" plain)"
assert_eq "toml nested section" "127.0.0.1:9091" "$(toml_value "$TMP/t.toml" server.api listen)"
assert_eq "toml hash inside quotes" "Bearer a#b" "$(toml_value "$TMP/t.toml" server.api auth_header)"
assert_eq "toml bool" "true" "$(toml_value "$TMP/t.toml" server.api enabled)"
assert_eq "toml missing key" "" "$(toml_value "$TMP/t.toml" auth password_hash)"
assert_eq "toml missing file" "" "$(toml_value "$TMP/nope.toml" auth username)"

# ── toml_escape ──────────────────────────────────────────────────────────────
assert_eq "toml_escape" 'a\\b\"c' "$(toml_escape 'a\b"c')"

# ── host_port_split / health_url ─────────────────────────────────────────────
host_port_split "0.0.0.0:8080" && assert_eq "split port" "8080" "$SPLIT_PORT"
assert_eq "split host" "0.0.0.0" "$SPLIT_HOST"
if host_port_split "nonsense"; then fail "split accepts nonsense"; else pass; fi
assert_eq "health url any" "http://127.0.0.1:8080/api/health" "$(health_url 0.0.0.0:8080)"
assert_eq "health url ipv6 any" "http://127.0.0.1:81/api/health" "$(health_url '[::]:81')"
assert_eq "health url explicit" "http://10.0.0.5:8080/api/health" "$(health_url 10.0.0.5:8080)"

# ── mask ─────────────────────────────────────────────────────────────────────
assert_eq "mask short" "***" "$(mask abc)"
assert_eq "mask long" "abc…xyz" "$(mask abcdefxyz)"

# ── generators: shared answers ───────────────────────────────────────────────
TELEMT_URL="http://127.0.0.1:9091"
TELEMT_AUTH='he"ad\er'
LISTEN="0.0.0.0:8080"
ADMIN_USER="admin"
PASS_HASH='$2a$10$hash'
SUBPAGE_ENABLED="yes"
SUBPAGE_SECRET="deadbeef"
TELEMT_BIN="/bin/telemt"
TELEMT_SVC="telemt"
RUN_AS="user"
DATA_DIR="/var/lib/telemt-panel"
PANEL_BIN="/usr/local/bin/telemt-panel"

# ── gen_config ───────────────────────────────────────────────────────────────
INIT="systemd"
gen_config >"$TMP/cfg.toml"
assert_eq "config listen" "0.0.0.0:8080" "$(toml_value "$TMP/cfg.toml" "" listen)"
assert_contains "config escaped header" 'auth_header = "he\"ad\\er"' "$TMP/cfg.toml"
assert_eq "config privileges sudo" "sudo" "$(toml_value "$TMP/cfg.toml" privileges mode)"
assert_eq "config subpage on" "true" "$(toml_value "$TMP/cfg.toml" subpage enabled)"
assert_eq "config subpage secret" "deadbeef" "$(toml_value "$TMP/cfg.toml" subpage secret)"
assert_eq "config telemt bin" "/bin/telemt" "$(toml_value "$TMP/cfg.toml" updates telemt_binary_path)"
assert_eq "config durable store" "sqlite" "$(toml_value "$TMP/cfg.toml" store driver)"
assert_eq "config sqlite path" "/var/lib/telemt-panel/panel.db" "$(toml_value "$TMP/cfg.toml" store path)"
STORE_DRIVER="sqlite"
INIT="procd"
gen_config >"$TMP/cfg-procd.toml"
assert_eq "config procd memory store" "memory" "$(toml_value "$TMP/cfg-procd.toml" store driver)"
assert_not_contains "config procd no sqlite path" 'path = "/var/lib/telemt-panel/panel.db"' "$TMP/cfg-procd.toml"
INIT="systemd"
RUN_AS="root"; SUBPAGE_ENABLED="no"
gen_config >"$TMP/cfg2.toml"
assert_eq "config privileges direct" "direct" "$(toml_value "$TMP/cfg2.toml" privileges mode)"
assert_eq "config subpage off" "false" "$(toml_value "$TMP/cfg2.toml" subpage enabled)"
L="ru"
gen_config >"$TMP/cfg3.toml"
assert_contains "config russian comments" "# Панель никогда не переписывает" "$TMP/cfg3.toml"
L="en"
RUN_AS="user"; SUBPAGE_ENABLED="yes"

# ── gen_sudoers ──────────────────────────────────────────────────────────────
INIT="systemd"
gen_sudoers >"$TMP/sudoers"
assert_eq "sudoers line count" "18" "$(wc -l <"$TMP/sudoers")"
_cp=$(command -v cp); _mv=$(command -v mv); _chmod=$(command -v chmod)
assert_contains "sudoers telemt backup" "telemt-panel ALL=(root) NOPASSWD: $_cp -f /var/lib/telemt-panel/staging/runs/telemt/backup /bin/telemt.bak.tmp" "$TMP/sudoers"
assert_contains "sudoers telemt install" "NOPASSWD: $_cp -f /var/lib/telemt-panel/staging/runs/telemt/bin /bin/telemt.tmp" "$TMP/sudoers"
assert_contains "sudoers telemt restore" "NOPASSWD: $_cp -f /bin/telemt.bak /bin/telemt.tmp" "$TMP/sudoers"
assert_contains "sudoers telemt chmod" "NOPASSWD: $_chmod 0755 /bin/telemt.tmp" "$TMP/sudoers"
assert_contains "sudoers telemt mv" "NOPASSWD: $_mv -f /bin/telemt.tmp /bin/telemt" "$TMP/sudoers"
assert_contains "sudoers panel install" "NOPASSWD: $_cp -f /var/lib/telemt-panel/staging/runs/panel/bin /usr/local/bin/telemt-panel.tmp" "$TMP/sudoers"
assert_contains "sudoers systemd restart" "NOPASSWD: $TMP/bin/systemctl restart telemt-panel" "$TMP/sudoers"
assert_not_contains "sudoers no wildcard" "*" "$TMP/sudoers"
assert_not_contains "sudoers no rm" " rm " "$TMP/sudoers"
INIT="openrc"
gen_sudoers >"$TMP/sudoers2"
assert_contains "sudoers openrc restart" "NOPASSWD: $TMP/bin/rc-service telemt restart" "$TMP/sudoers2"
INIT="sysvinit"
gen_sudoers >"$TMP/sudoers3"
assert_contains "sudoers sysvinit restart" "NOPASSWD: /etc/init.d/telemt restart" "$TMP/sudoers3"
if has visudo; then
  if visudo -cf "$TMP/sudoers" >/dev/null 2>&1; then pass; else fail "visudo rejects generated sudoers"; fi
fi
PANEL_BIN="/opt/my panel/telemt-panel"
if (gen_sudoers >/dev/null 2>&1); then fail "sudoers accepts whitespace path"; else pass; fi
PANEL_BIN="/usr/local/bin/telemt-panel"

# ── gen_service_* ────────────────────────────────────────────────────────────
INIT="systemd"; RUN_AS="user"
gen_service >"$TMP/unit"
assert_contains "unit user" "User=telemt-panel" "$TMP/unit"
assert_contains "unit exec" "ExecStart=/usr/local/bin/telemt-panel --config /etc/telemt-panel/config.toml" "$TMP/unit"
RUN_AS="root"
gen_service >"$TMP/unit-root"
assert_not_contains "unit root has no User=" "User=" "$TMP/unit-root"
INIT="openrc"; RUN_AS="user"
gen_service >"$TMP/openrc"
assert_contains "openrc shebang" "#!/sbin/openrc-run" "$TMP/openrc"
assert_contains "openrc user" 'command_user="telemt-panel:telemt-panel"' "$TMP/openrc"
INIT="procd"; RUN_AS="root"
gen_service >"$TMP/procd"
assert_contains "procd rc.common" "#!/bin/sh /etc/rc.common" "$TMP/procd"
assert_contains "procd command" "procd_set_param command /usr/local/bin/telemt-panel --config /etc/telemt-panel/config.toml" "$TMP/procd"
INIT="sysvinit"; RUN_AS="user"
gen_service >"$TMP/sysv"
assert_contains "sysvinit chuid" 'CHUID="--chuid telemt-panel"' "$TMP/sysv"
assert_contains "sysvinit lsb" "# Provides:          telemt-panel" "$TMP/sysv"
if [ "$(sh -n "$TMP/sysv" 2>&1)" = "" ]; then pass; else fail "sysvinit script has syntax errors"; fi

# Legacy parsing is covered by the shared Go decoder, not an AWK converter.
BIN="${TP_TEST_BINARY:-$HERE/../telemt-panel}"
if [ -x "$BIN" ]; then
  _hash=$(printf 'test-password\n' | "$BIN" hash-password)
  printf "listen = '127.0.0.1:8090'\n[telemt]\nurl='http://127.0.0.1:1'\n[auth]\nusername='boss'\npassword_hash='%s'\njwt_secret='legacy'\n" "$_hash" >"$TMP/v0.toml"
  cp "$TMP/v0.toml" "$TMP/v0-original.toml"
  "$BIN" config inspect --config "$TMP/v0.toml" >"$TMP/legacy-inspect.json"
  assert_contains "typed legacy recognized" '"format": "0.6"' "$TMP/legacy-inspect.json"
  assert_contains "old TTL preserved" '"session_ttl": "24h0m0s"' "$TMP/legacy-inspect.json"
  if cmp -s "$TMP/v0.toml" "$TMP/v0-original.toml"; then pass; else fail "source modified"; fi
fi

# ── detection helpers on this host ───────────────────────────────────────────
detect_arch
case "$ARCH" in x86_64|aarch64|armv7|mipsle|mips) pass ;; *) fail "detect_arch: $ARCH" ;; esac
detect_libc
case "$LIBC" in gnu|musl) pass ;; *) fail "detect_libc: $LIBC" ;; esac

# ── build variant and release asset selection ────────────────────────────────
INIT="systemd"; ARCH="x86_64"; LIBC="gnu"; PANEL_BIN="$TMP/no-panel"; BUILD_VARIANT=""; TP_VARIANT=""
choose_build_variant
assert_eq "server defaults full" "full" "$BUILD_VARIANT"
assert_eq "full release asset" "telemt-panel-x86_64-linux-gnu.tar.gz" "$(release_asset_name)"
BUILD_VARIANT=""; TP_VARIANT="lite"
choose_build_variant
assert_eq "variant override lite" "lite" "$BUILD_VARIANT"
assert_eq "lite release asset" "telemt-panel-lite-x86_64-linux-gnu.tar.gz" "$(release_asset_name)"
TP_VARIANT=""; BUILD_VARIANT=""; INIT="procd"
choose_build_variant
assert_eq "procd defaults lite" "lite" "$BUILD_VARIANT"

# An update keeps config.toml intact, so a full -> lite switch must be refused
# before installing a binary that cannot open the configured SQL store.
# TOML defaults are covered by the Go decoder; shell enforces profile policy.
BUILD_VARIANT=lite
STORE_DRIVER=sqlite
if (validate_existing_store_variant) >/dev/null 2>&1; then fail "lite accepted SQLite"; else pass; fi
STORE_DRIVER=memory
if (validate_existing_store_variant) >/dev/null 2>&1; then pass; else fail "lite rejected memory"; fi

# Destructive operations must refuse broad targets before any host mutation.
for _dir in / /etc /var /var/lib /tmp /home /home/admin /usr/local /root relative /var/lib/../..; do
  if (validate_panel_directory "$_dir") >/dev/null 2>&1; then
    fail "directory guard accepted $_dir"
  else
    pass
  fi
done
mkdir -p "$TMP/panel-data"
ln -s / "$TMP/root-link"
if (validate_panel_directory "$TMP/root-link") >/dev/null 2>&1; then
  fail "directory guard accepted symlink to root"
else
  pass
fi
if (validate_panel_directory "$TMP/panel-data") >/dev/null 2>&1; then pass; else fail "directory guard rejected dedicated directory"; fi
if (validate_panel_directory "$TMP/new-panel-data") >/dev/null 2>&1; then pass; else fail "directory guard rejected new dedicated directory"; fi
for _dir in / /tmp "$TMP/root-link"; do
  if (
    CONFIG_DIR="$TMP/panel-data"; DATA_DIR="$_dir"
    require_tty() { :; }
    check_prereqs_quiet() { :; }
    detect_init() { :; }
    apply_layout() { :; }
    detect_existing() { EXISTING=none; }
    confirm_danger() { return 0; }
    do_uninstall() { printf 'uninstall\n' >>"$TMP/unsafe-mutations"; }
    run() { printf 'run\n' >>"$TMP/unsafe-mutations"; }
    do_purge
  ) >/dev/null 2>&1; then fail "purge accepted unsafe directory"; else pass; fi
done
if [ -e "$TMP/unsafe-mutations" ]; then fail "purge mutated host before rejecting unsafe path"; else pass; fi
if (
  CONFIG_DIR="$TMP/panel-data"; DATA_DIR=/
  run() { printf 'run\n' >>"$TMP/unsafe-setup"; }
  setup_dirs
) >/dev/null 2>&1; then fail "setup accepted root data directory"; else pass; fi
if [ -e "$TMP/unsafe-setup" ]; then fail "setup mutated host before rejecting unsafe path"; else pass; fi

# Sudoers arguments are literal paths, never patterns or policy syntax.
for _path in '/usr/bin/*' '/usr/bin/panel?' '/usr/bin/[panel]' '/usr/bin/panel,ALL' '/usr/bin/panel:other' '/usr/bin/panel#comment'; do
  if sudoers_path_ok "$_path"; then fail "sudoers accepted metacharacters: $_path"; else pass; fi
done
if sudoers_path_ok /usr/local/bin/telemt-panel; then pass; else fail "sudoers rejected normal path"; fi
for _service in '*' '../other' 'telemt;id' '-other' 'telemt,ALL' 'telemt:other'; do
  if service_name_ok "$_service"; then fail "service accepted unsafe name: $_service"; else pass; fi
done
if service_name_ok telemt@main.service; then pass; else fail "service rejected normal template instance"; fi

SERVICE_NAME=panel-custom
INIT=systemd
apply_layout_from_answers
assert_eq "custom service file" "/etc/systemd/system/panel-custom.service" "$SERVICE_FILE"

# A failed readiness probe is a failed installation, not a success warning.
if (
  DRY_RUN=0; NO_START=0; HEALTH_WAIT_SECONDS=1; LISTEN=127.0.0.1:8080
  run() { :; }
  sleep() { :; }
  http_get() { printf 503; }
  start_service
) >"$TMP/health-failure.log" 2>&1; then fail "failed health returned success"; else pass; fi
if (
  DRY_RUN=0; NO_START=0; HEALTH_WAIT_SECONDS=1; LISTEN=127.0.0.1:8080
  run() { :; }
  http_get() { printf 200; }
  start_service
) >/dev/null 2>&1; then pass; else fail "healthy panel rejected"; fi

# Remote releases require a verified checksum before extraction/installation.
for _scenario in missing no-tool mismatch; do
  if (
    BINARY_FILE=""; BUILD_VARIANT=full; ARCH=x86_64; LIBC=gnu
    resolve_tag() { INSTALLED_TAG=v1.0.0; }
    sha256_of() { [ "$_scenario" = no-tool ] || printf '%064d' 0; }
    download() {
      case "$1" in
        *.sha256)
          [ "$_scenario" != missing ] || return 1
          printf '%064d\n' 1 >"$2" ;;
        *) printf 'synthetic archive\n' >"$2" ;;
      esac
    }
    tar() { printf 'extract\n' >>"$TMP/unverified-extraction"; }
    fetch_release
  ) >"$TMP/checksum-$_scenario.log" 2>&1; then fail "unverified release accepted: $_scenario"; else pass; fi
done
if [ -e "$TMP/unverified-extraction" ]; then fail "unverified archive extracted"; else pass; fi

# Explicit transport choices and service privileges.
for _tls in http proxy acme; do
  (
    TP_TLS_MODE="$_tls"; TP_TLS_DOMAIN=panel.example.com
    LISTEN=""
    ask_transport
    DATA_DIR="$TMP/state"; gen_tls_config
    printf 'listen = "%s"\n' "$LISTEN"
  ) >"$TMP/transport-$_tls" 2>&1
done
assert_contains "plain mode remains available" 'mode = "http"' "$TMP/transport-http"
assert_contains "plain mode warns" 'unencrypted' "$TMP/transport-http"
assert_contains "proxy loopback" 'listen = "127.0.0.1:8080"' "$TMP/transport-proxy"
assert_contains "ACME domain" 'acme_domain = "panel.example.com"' "$TMP/transport-acme"
assert_contains "ACME avoids Telemt 443" 'listen = "0.0.0.0:8443"' "$TMP/transport-acme"
for _domain in '' localhost 127.0.0.1 '*.example.com' 'example.com:443' 'https://example.com' 'a..com' '-a.com'; do
  if tls_domain_ok "$_domain"; then fail "accepted ACME domain $_domain"; else pass; fi
done
if tls_domain_ok panel.example.com; then pass; else fail "normal domain rejected"; fi
(
  RUN_AS=user; INIT=systemd; TLS_MODE=acme; LISTEN=0.0.0.0:8443
  gen_service_systemd
) >"$TMP/acme-unit"
assert_contains "ACME bind capability" 'AmbientCapabilities=CAP_NET_BIND_SERVICE' "$TMP/acme-unit"
(
  RUN_AS=user; INIT=systemd; TLS_MODE=http; LISTEN=127.0.0.1:8080
  gen_service_systemd
) >"$TMP/http-unit"
assert_not_contains "HTTP no extra capability" 'AmbientCapabilities=' "$TMP/http-unit"
if (RUN_AS=user; INIT=openrc; TLS_MODE=acme; validate_transport_rights) >/dev/null 2>&1; then fail "unprovisioned ACME bind accepted"; else pass; fi
if (RUN_AS=root; INIT=openrc; TLS_MODE=acme; LISTEN=:8443; validate_transport_rights) >/dev/null 2>&1; then pass; else fail "explicit root ACME refused"; fi

if (
  TLS_MODE=acme; NO_START=0; DRY_RUN=0; SUDO=""; PANEL_BIN=false
  run() { :; }; cmd_restart() { printf true; }
  start_service
) >/dev/null 2>&1; then fail "TLS readiness failure ignored"; else pass; fi

if sh "$HERE/install-remove-test.sh" >"$TMP/remove-test.log" 2>&1; then
  pass
else
  fail "removal fixture failed: $(cat "$TMP/remove-test.log")"
fi

if sh "$HERE/install-update-test.sh" >"$TMP/update-test.log" 2>&1; then
  pass
else
  fail "update transaction fixture failed: $(cat "$TMP/update-test.log")"
fi

# Firewall behavior lives in a focused PATH-stubbed fixture and remains part of
# the full installer test entrypoint.
if sh "$HERE/install-firewall-test.sh" >"$TMP/firewall-test.log" 2>&1; then
  pass
else
  fail "firewall fixture failed: $(tail -20 "$TMP/firewall-test.log")"
fi

printf '%s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
