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
assert_eq "migrate HTTP transport" "http" "$(toml_value "$TMP/v1.toml" tls mode)"
assert_eq "migrate subpage secret set" "64" "$(printf '%s' "$(toml_value "$TMP/v1.toml" subpage secret)" | wc -c)"
case "$MIGRATE_SKIPPED" in
  *auth.jwt_secret*) pass ;; *) fail "skipped list lacks jwt_secret" ;;
esac
case "$MIGRATE_SKIPPED" in
  *"*.auto_update"*) pass ;; *) fail "skipped list lacks auto_update" ;;
esac
case "$MIGRATE_SKIPPED" in
  *"tls.*"*) fail "HTTP migration reports lost TLS" ;; *) pass ;;
esac
case "$MIGRATE_SKIPPED" in
  *"panel.max_*_releases"*) pass ;; *) fail "skipped list lacks max releases" ;;
esac
case "$MIGRATE_SKIPPED" in
  *"telemt.config_path"*) pass ;; *) fail "skipped list lacks config_path" ;;
esac

# Exercise the confirmation boundary without running host/service operations.
# shellcheck disable=SC2094  # the confirmation stub reads output already written to the log
for _lang in en ru; do
  if (
    L="$_lang"
    TEMP_DIR="$TMP/migrate-$_lang"
    mkdir -p "$TEMP_DIR"
    CONFIG_FILE="$TEMP_DIR/config.toml"
    cp "$TMP/v0.toml" "$CONFIG_FILE"
    ask_choice() { _c=1; }
    ask_subpage() { :; }
    ask_run_as() { RUN_AS=root; }
    apply_layout_from_answers() { :; }
    print_summary() { :; }
    confirm() {
      # The warning must already be visible when confirmation is requested.
      grep -qF "$(t migrate_config_api_only)" "$TMP/migrate-$_lang.log"
    }
    write_root_file() {
      [ "$2" = 0600 ] && [ "$3" = root ] || exit 1
      cat >"$1"
    }
    create_user() { :; }
    setup_dirs() { :; }
    fetch_release() { :; }
    install_binary() { :; }
    run_quiet() {
      case "$*" in *'*.bak'*) exit 1 ;; esac
    }
    install_sudoers() { :; }
    install_service() { :; }
    start_service() { :; }
    print_done() { :; }
    do_migrate
    # shellcheck disable=SC2154  # assigned by do_migrate in the sourced installer
    cmp "$TMP/v0.toml" "$_backup" || exit 1
    [ "$(toml_value "$CONFIG_FILE" telemt config_edit_mode)" = file ] || exit 1
    [ "$(toml_value "$CONFIG_FILE" auth password_hash)" = '$2a$10$oldhash' ] || exit 1
    [ "$(toml_value "$CONFIG_FILE" host telemt_service)" = telemt-custom ] || exit 1
    [ "$(toml_value "$CONFIG_FILE" updates telemt_binary_path)" = /usr/local/bin/telemt ]
  ) >"$TMP/migrate-$_lang.log" 2>&1; then
    # A rejected confirmation exits successfully, so verify application too.
    if [ "$(toml_value "$TMP/migrate-$_lang/config.toml" updates telemt_binary_path)" = /usr/local/bin/telemt ]; then
      pass
    else
      fail "$_lang migration warning missing before confirmation"
    fi
  else
    fail "$_lang migration fixture failed"
  fi
done

for _mode in api absent unknown; do
  if [ "$_mode" = absent ]; then
    sed '/^config_edit_mode = /d' "$TMP/v0.toml" >"$TMP/mode.toml"
    _expected=""
  else
    sed "s/^config_edit_mode = .*/config_edit_mode = \"$_mode\"/" "$TMP/v0.toml" >"$TMP/mode.toml"
    _expected="$_mode"
  fi
  cp "$TMP/mode.toml" "$TMP/mode-original.toml"
  migrate_v0_config "$TMP/mode.toml" "$TMP/mode-new.toml"
  assert_eq "migrate $_mode stays literal" "$_expected" "$(toml_value "$TMP/mode-new.toml" telemt config_edit_mode)"
  if cmp -s "$TMP/mode.toml" "$TMP/mode-original.toml"; then pass; else fail "migration changed source"; fi
done

# The migrated config must load in the real binary when one is available.
BIN="${TP_TEST_BINARY:-$HERE/../telemt-panel}"
if [ -x "$BIN" ]; then
  sed -e 's#^data_dir = .*#data_dir = ""#' \
      -e 's#^listen = .*#listen = "127.0.0.1:0"#' \
      -e 's#^url = .*#url = "http://127.0.0.1:1"#' \
      -e "s#^path = .*#path = \"$TMP/panel.db\"#" \
      "$TMP/v1.toml" >"$TMP/v1-run.toml"
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
cat >"$TMP/existing-v1.toml" <<'EOF'
[store]
driver = "sqlite"
path = "/var/lib/telemt-panel/panel.db"
EOF
CONFIG_FILE="$TMP/existing-v1.toml"
BUILD_VARIANT="lite"
load_v1_config
assert_eq "existing store driver loaded" "sqlite" "$STORE_DRIVER"
if (validate_existing_store_variant) >/dev/null 2>&1; then
  fail "lite accepted existing sqlite store"
else
  pass
fi

cat >"$TMP/existing-memory-v1.toml" <<'EOF'
[store]
driver = "memory"
EOF
CONFIG_FILE="$TMP/existing-memory-v1.toml"
load_v1_config
if (validate_existing_store_variant) >/dev/null 2>&1; then
  pass
else
  fail "lite rejected existing memory store"
fi

# Configs written before the store section existed used the memory backend.
: >"$TMP/existing-legacy-v1.toml"
CONFIG_FILE="$TMP/existing-legacy-v1.toml"
STORE_DRIVER="sqlite"
load_v1_config
assert_eq "missing store section means memory" "memory" "$STORE_DRIVER"
if (validate_existing_store_variant) >/dev/null 2>&1; then
  pass
else
  fail "lite rejected legacy memory config"
fi

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

cat >"$TMP/custom-service.toml" <<'EOF'
[host]
panel_service = "panel-custom"
[privileges]
mode = "direct"
EOF
CONFIG_FILE="$TMP/custom-service.toml"
INIT=systemd
load_v1_config
assert_eq "existing custom panel service" "panel-custom" "$SERVICE_NAME"
apply_layout_from_answers
assert_eq "existing custom service file" "/etc/systemd/system/panel-custom.service" "$SERVICE_FILE"

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

cp "$TMP/v0.toml" "$TMP/v0-cert.toml"
printf '\n[tls]\ncert_file = "/cert.pem"\nkey_file = "/key.pem"\n' >>"$TMP/v0-cert.toml"
migrate_v0_config "$TMP/v0-cert.toml" "$TMP/v1-cert.toml"
assert_eq "preserve certificate mode" certificate "$(toml_value "$TMP/v1-cert.toml" tls mode)"
assert_eq "preserve certificate path" /cert.pem "$(toml_value "$TMP/v1-cert.toml" tls cert_file)"
assert_eq "preserve key path" /key.pem "$(toml_value "$TMP/v1-cert.toml" tls key_file)"
cp "$TMP/v0.toml" "$TMP/v0-acme.toml"
printf '\n[tls]\nacme_domain = "panel.example.com"\n' >>"$TMP/v0-acme.toml"
migrate_v0_config "$TMP/v0-acme.toml" "$TMP/v1-acme.toml"
assert_eq "preserve ACME mode" acme "$(toml_value "$TMP/v1-acme.toml" tls mode)"
assert_eq "preserve ACME domain" panel.example.com "$(toml_value "$TMP/v1-acme.toml" tls acme_domain)"
assert_eq "preserve legacy default ACME cache" /var/lib/telemt-panel/certs "$(toml_value "$TMP/v1-acme.toml" tls acme_cache_dir)"
if (
  TLS_MODE=acme; NO_START=0; DRY_RUN=0; SUDO=""; PANEL_BIN=false
  run() { :; }; cmd_restart() { printf true; }
  start_service
) >/dev/null 2>&1; then fail "TLS readiness failure ignored"; else pass; fi

# Firewall behavior lives in a focused PATH-stubbed fixture and remains part of
# the full installer test entrypoint.
if sh "$HERE/install-firewall-test.sh" >"$TMP/firewall-test.log" 2>&1; then
  pass
else
  fail "firewall fixture failed: $(tail -20 "$TMP/firewall-test.log")"
fi

printf '%s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
