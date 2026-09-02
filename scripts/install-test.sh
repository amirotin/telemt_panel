#!/bin/sh
# Unit tests for install.sh: sources the installer with TP_SOURCED=1 and
# exercises its pure functions (TOML reader, generators, 0.x migration)
# without touching the host. Runs under dash, bash and busybox sh:
#
#   sh scripts/install-test.sh
#   bash scripts/install-test.sh
# shellcheck disable=SC2034,SC2016  # globals are consumed by the sourced installer
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
gen_config >"$TMP/cfg.toml"
assert_eq "config listen" "0.0.0.0:8080" "$(toml_value "$TMP/cfg.toml" "" listen)"
assert_contains "config escaped header" 'auth_header = "he\"ad\\er"' "$TMP/cfg.toml"
assert_eq "config privileges sudo" "sudo" "$(toml_value "$TMP/cfg.toml" privileges mode)"
assert_eq "config subpage on" "true" "$(toml_value "$TMP/cfg.toml" subpage enabled)"
assert_eq "config subpage secret" "deadbeef" "$(toml_value "$TMP/cfg.toml" subpage secret)"
assert_eq "config telemt bin" "/bin/telemt" "$(toml_value "$TMP/cfg.toml" updates telemt_binary_path)"
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

# ── migrate_v0_config ────────────────────────────────────────────────────────
INIT="systemd"
cat >"$TMP/v0.toml" <<'EOF'
listen = "127.0.0.1:8090"
base_path = "/panel"
data_dir = "/var/lib/telemt-panel"
trusted_proxies = ["127.0.0.1/32"]

[telemt]
url = "http://127.0.0.1:9091"
auth_header = "Bearer old"
binary_path = "/usr/local/bin/telemt"
service_name = "telemt-custom"
config_path = "/etc/telemt/telemt.toml"
config_edit_mode = "file"

[telemt.auto_update]
enabled = true

[panel]
binary_path = "/usr/local/bin/telemt-panel"
service_name = "telemt-panel"
github_token = "ghp_x"
max_newer_releases = 5

[auth]
username = "boss"
password_hash = "$2a$10$oldhash"
jwt_secret = "abc"
session_ttl = "24h"

[tls]
cert_file = "/x.pem"
EOF
migrate_v0_config "$TMP/v0.toml" "$TMP/v1.toml"
assert_eq "migrate listen" "127.0.0.1:8090" "$(toml_value "$TMP/v1.toml" "" listen)"
assert_eq "migrate base_path" "/panel" "$(toml_value "$TMP/v1.toml" "" base_path)"
assert_contains "migrate trusted_proxies" 'trusted_proxies = ["127.0.0.1/32"]' "$TMP/v1.toml"
assert_eq "migrate telemt url" "http://127.0.0.1:9091" "$(toml_value "$TMP/v1.toml" telemt url)"
assert_eq "migrate auth header" "Bearer old" "$(toml_value "$TMP/v1.toml" telemt auth_header)"
assert_eq "migrate telemt binary" "/usr/local/bin/telemt" "$(toml_value "$TMP/v1.toml" updates telemt_binary_path)"
assert_eq "migrate telemt service" "telemt-custom" "$(toml_value "$TMP/v1.toml" host telemt_service)"
assert_eq "migrate username" "boss" "$(toml_value "$TMP/v1.toml" auth username)"
assert_eq "migrate hash" '$2a$10$oldhash' "$(toml_value "$TMP/v1.toml" auth password_hash)"
assert_contains "migrate session_ttl" 'session_ttl = "24h"' "$TMP/v1.toml"
assert_contains "migrate edit mode" 'config_edit_mode = "file"' "$TMP/v1.toml"
assert_contains "migrate github token" 'github_token = "ghp_x"' "$TMP/v1.toml"
assert_not_contains "migrate drops jwt" "jwt_secret" "$TMP/v1.toml"
assert_not_contains "migrate drops tls" "cert_file" "$TMP/v1.toml"
assert_eq "migrate subpage secret set" "64" "$(printf '%s' "$(toml_value "$TMP/v1.toml" subpage secret)" | wc -c)"
case "$MIGRATE_SKIPPED" in
  *auth.jwt_secret*) pass ;; *) fail "skipped list lacks jwt_secret" ;;
esac
case "$MIGRATE_SKIPPED" in
  *"*.auto_update"*) pass ;; *) fail "skipped list lacks auto_update" ;;
esac
case "$MIGRATE_SKIPPED" in
  *"tls.*"*) pass ;; *) fail "skipped list lacks tls" ;;
esac
case "$MIGRATE_SKIPPED" in
  *"panel.max_*_releases"*) pass ;; *) fail "skipped list lacks max releases" ;;
esac
case "$MIGRATE_SKIPPED" in
  *"telemt.config_path"*) pass ;; *) fail "skipped list lacks config_path" ;;
esac

# The migrated config must load in the real binary when one is available.
BIN="${TP_TEST_BINARY:-$HERE/../telemt-panel}"
if [ -x "$BIN" ]; then
  sed 's#^data_dir = .*#data_dir = ""#; s#^listen = .*#listen = "127.0.0.1:0"#' "$TMP/v1.toml" >"$TMP/v1-run.toml"
  # The binary needs a port and a reachable-or-not Telemt; both are fine
  # for a load check because the panel starts even with Telemt down.
  ( "$BIN" --config "$TMP/v1-run.toml" >"$TMP/panel.log" 2>&1 & echo $! >"$TMP/pid" )
  sleep 2
  if kill -0 "$(cat "$TMP/pid")" 2>/dev/null; then
    pass
  else
    fail "binary refused migrated config: $(cat "$TMP/panel.log")"
  fi
  kill "$(cat "$TMP/pid")" 2>/dev/null || true
fi

# ── detection helpers on this host ───────────────────────────────────────────
detect_arch
case "$ARCH" in x86_64|aarch64|armv7|mipsle|mips) pass ;; *) fail "detect_arch: $ARCH" ;; esac
detect_libc
case "$LIBC" in gnu|musl) pass ;; *) fail "detect_libc: $LIBC" ;; esac

printf '%s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
