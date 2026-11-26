#!/bin/sh
# Unit tests for install.sh: sources the installer with TP_SOURCED=1 and
# exercises its pure functions (TOML reader, generators, 0.x migration)
# without touching the host. Runs under dash, bash and busybox sh:
#
#   sh scripts/install-test.sh
#   bash scripts/install-test.sh
# shellcheck disable=SC2034,SC2016  # globals are consumed by the sourced installer
# shellcheck disable=SC2317,SC2329  # stubs are called by functions from the sourced installer
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
assert_eq "health url prefix" "http://127.0.0.1:8080/private/panel/api/health" "$(health_url 127.0.0.1:8080 /private/panel)"
assert_eq "health url ipv6 prefix" "http://[::1]:8080/panel/api/health" "$(health_url '[::1]:8080' /panel)"

# Proxy path selection must agree with the panel's generated root-level config.
for _path in /panel panel /private/panel /panel/ /a._~-9; do
  if normalize_proxy_path "$_path"; then pass; else fail "valid path rejected $_path"; fi
done
normalize_proxy_path panel/
assert_eq "path normalized" /panel "$BASE_PATH"
for _path in '/a//b' '/a/../b' '/.' '/..' '/a/.' '/a/..' 'https://example.com' '/a?b' '/a#b' '/a b' '/a%2fb' '/панель' '/a;return' '/a$host' '/a{b'; do
  if normalize_proxy_path "$_path"; then fail "unsafe path accepted $_path"; else pass; fi
done
normalize_proxy_path /
assert_eq "root stored empty" '' "$BASE_PATH"
(
  TP_TLS_MODE=proxy; unset TP_BASE_PATH
  ask_transport >/dev/null
  printf '%s|%s|%s\n' "$BEHIND_PROXY" "$BASE_PATH" "$LISTEN"
) >"$TMP/proxy-root"
assert_eq "proxy defaults to root" '1||127.0.0.1:8080' "$(cat "$TMP/proxy-root")"
(
  TP_TLS_MODE=proxy; TP_BASE_PATH=/private/panel/
  ask_transport >/dev/null
  gen_config
) >"$TMP/proxy-custom.toml"
assert_eq "proxy config root base_path" /private/panel "$(toml_value "$TMP/proxy-custom.toml" '' base_path)"
assert_eq "no base_path in tls table" '' "$(toml_value "$TMP/proxy-custom.toml" tls base_path)"
(
  TP_TLS_MODE=proxy; TP_BASE_PATH=random
  ask_transport >/dev/null
  printf '%s\n' "$BASE_PATH"
) >"$TMP/proxy-random"
if grep -Eq '^/[0-9a-f]{24}$' "$TMP/proxy-random"; then pass; else fail "random path format"; fi
if (
  has() { [ "$1" != openssl ] && command -v "$1" >/dev/null 2>&1; }
  od() { return 127; }
  secret=$(gen_secret) || exit 1
  [ "${#secret}" -eq 64 ] || exit 1
  case "$secret" in *[!0-9a-f]*) exit 1 ;; esac
); then pass; else fail 'secret generation requires openssl or od'; fi
if (
  has() { return 1; }
  tr() { cat >/dev/null; printf '0123'; }
  gen_secret
) >/dev/null 2>&1; then fail 'secret generation accepted a short result'; else pass; fi
if (TP_TLS_MODE=proxy; TP_BASE_PATH='/../x'; ask_transport) >/dev/null 2>&1; then fail "invalid unattended path accepted"; else pass; fi
if (TP_TLS_MODE=http; TP_BASE_PATH=/panel; ask_transport) >/dev/null 2>&1; then fail "path silently ignored outside proxy mode"; else pass; fi
(
  ASSUME_YES=0
  read_tty() {
    case "$PROXY_INPUT" in
      0) _val=2 ;; 1) _val='/bad path' ;; 2) _val='/chosen' ;;
    esac
    PROXY_INPUT=$((PROXY_INPUT + 1))
  }
  PROXY_INPUT=0
  ask_proxy_path >/dev/null
  printf '%s\n' "$BASE_PATH"
) >"$TMP/proxy-retry" 2>/dev/null
assert_eq "invalid interactive path can be corrected" /chosen "$(cat "$TMP/proxy-retry")"
(
  LISTEN=127.0.0.1:8080; BASE_PATH=/private/panel
  print_proxy_example
) >"$TMP/proxy-example"
assert_contains "nginx exact redirect" 'location = /private/panel { return 308 /private/panel/; }' "$TMP/proxy-example"
assert_contains "nginx prefix preserved" 'proxy_pass http://127.0.0.1:8080;' "$TMP/proxy-example"
assert_contains "nginx streams events" 'proxy_buffering off;' "$TMP/proxy-example"
assert_contains "caddy prefix preserved" 'handle /private/panel/* {' "$TMP/proxy-example"
assert_not_contains "no caddy path stripping" 'handle_path' "$TMP/proxy-example"
(
  LISTEN=127.0.0.1:8080; BASE_PATH=''
  print_proxy_example
) >"$TMP/proxy-example-root"
assert_contains "nginx root" 'location ^~ / {' "$TMP/proxy-example-root"
assert_not_contains "no root redirect loop" 'return 308' "$TMP/proxy-example-root"
if (
  LISTEN=127.0.0.1:8080; BASE_PATH=/panel; NO_START=0; DRY_RUN=0; TLS_MODE=http
  cmd_restart() { printf 'true'; }
  run() { return 0; }
  http_get() { if [ "$1" = http://127.0.0.1:8080/panel/api/health ]; then printf 200; else printf 404; fi; }
  HEALTH_WAIT_SECONDS=1
  start_service
) >"$TMP/proxy-health" 2>&1; then pass; else fail "prefixed service health probe failed"; fi
BASE_PATH=''

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
assert_eq "explicit procd sqlite store" sqlite "$(toml_value "$TMP/cfg-procd.toml" store driver)"
BUILD_VARIANT=full
ask_storage >/dev/null
gen_config >"$TMP/cfg-procd.toml"
assert_eq "config procd memory store" "memory" "$(toml_value "$TMP/cfg-procd.toml" store driver)"
assert_not_contains "config procd no sqlite path" 'path = "/var/lib/telemt-panel/panel.db"' "$TMP/cfg-procd.toml"
if (BUILD_VARIANT=lite; TP_STORE_DRIVER=sqlite; ask_storage) >/dev/null 2>&1; then fail "lite accepted explicit sqlite"; else pass; fi
for _option in --version --binary --lang --variant --user; do
  if (parse_args "$_option" --yes) >/dev/null 2>&1; then fail "missing argument accepted: $_option"; else pass; fi
done
INIT="systemd"
STORE_DRIVER=sqlite
RUN_AS="root"; SUBPAGE_ENABLED="no"
gen_config >"$TMP/cfg2.toml"
assert_eq "config privileges direct" "direct" "$(toml_value "$TMP/cfg2.toml" privileges mode)"
assert_eq "config subpage off" "false" "$(toml_value "$TMP/cfg2.toml" subpage enabled)"
L="ru"
gen_config >"$TMP/cfg3.toml"
assert_contains "config russian comments" "# Параметры запуска панели." "$TMP/cfg3.toml"
L="en"
RUN_AS="user"; SUBPAGE_ENABLED="yes"

# ── gen_sudoers ──────────────────────────────────────────────────────────────
INIT="systemd"
gen_sudoers >"$TMP/sudoers"
assert_eq "sudoers line count" "13" "$(wc -l <"$TMP/sudoers")"
assert_contains "sudoers telemt backup" "NOPASSWD: $HELPER_FILE privileged --policy $POLICY_FILE backup telemt" "$TMP/sudoers"
assert_contains "sudoers telemt install" "NOPASSWD: $HELPER_FILE privileged --policy $POLICY_FILE install telemt" "$TMP/sudoers"
assert_contains "sudoers telemt restore" "NOPASSWD: $HELPER_FILE privileged --policy $POLICY_FILE restore telemt" "$TMP/sudoers"
assert_contains "sudoers readonly inspect" "NOPASSWD: $HELPER_FILE privileged --policy $POLICY_FILE inspect" "$TMP/sudoers"
assert_not_contains "sudoers excludes unsafe copy" " cp -f " "$TMP/sudoers"
assert_not_contains "sudoers excludes unsafe rename" " mv -f " "$TMP/sudoers"
assert_contains "sudoers panel install" "NOPASSWD: $HELPER_FILE privileged --policy $POLICY_FILE install panel" "$TMP/sudoers"
assert_contains "sudoers systemd restart" "NOPASSWD: $TMP/bin/systemctl restart telemt-panel" "$TMP/sudoers"
assert_contains "sudoers telemt start" "NOPASSWD: $TMP/bin/systemctl start telemt" "$TMP/sudoers"
assert_contains "sudoers telemt stop" "NOPASSWD: $TMP/bin/systemctl stop telemt" "$TMP/sudoers"
assert_not_contains "sudoers cannot stop panel" "systemctl stop telemt-panel" "$TMP/sudoers"
assert_not_contains "sudoers cannot start panel" "systemctl start telemt-panel" "$TMP/sudoers"
assert_not_contains "sudoers no wildcard" "*" "$TMP/sudoers"
assert_not_contains "sudoers no rm" " rm " "$TMP/sudoers"
INIT="openrc"
gen_sudoers >"$TMP/sudoers2"
assert_contains "sudoers openrc restart" "NOPASSWD: $TMP/bin/rc-service telemt restart" "$TMP/sudoers2"
assert_contains "sudoers openrc start" "NOPASSWD: $TMP/bin/rc-service telemt start" "$TMP/sudoers2"
assert_contains "sudoers openrc stop" "NOPASSWD: $TMP/bin/rc-service telemt stop" "$TMP/sudoers2"
INIT="sysvinit"
gen_sudoers >"$TMP/sudoers3"
assert_contains "sudoers sysvinit restart" "NOPASSWD: /etc/init.d/telemt restart" "$TMP/sudoers3"
assert_contains "sudoers sysvinit start" "NOPASSWD: /etc/init.d/telemt start" "$TMP/sudoers3"
assert_contains "sudoers sysvinit stop" "NOPASSWD: /etc/init.d/telemt stop" "$TMP/sudoers3"
INIT="procd"
gen_sudoers >"$TMP/sudoers-procd"
assert_contains "sudoers procd start" "NOPASSWD: /etc/init.d/telemt start" "$TMP/sudoers-procd"
assert_contains "sudoers procd stop" "NOPASSWD: /etc/init.d/telemt stop" "$TMP/sudoers-procd"
INIT="systemd"; TELEMT_SVC="telemt-panel.service"
gen_sudoers >"$TMP/sudoers-collision"
assert_not_contains "sudoers alias cannot start panel" "systemctl start" "$TMP/sudoers-collision"
assert_not_contains "sudoers alias cannot stop panel" "systemctl stop" "$TMP/sudoers-collision"
assert_contains "sudoers alias preserves restart" "systemctl restart telemt-panel.service" "$TMP/sudoers-collision"
TELEMT_SVC="telemt"; INIT="sysvinit"
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
case "$ARCH" in x86_64|aarch64) pass ;; *) fail "detect_arch: $ARCH" ;; esac
for _machine in armv7l armv8l mips mipsel mipsle i686 riscv64; do
  if (
    uname() { printf '%s\n' "$_machine"; }
    detect_arch
  ) >"$TMP/unsupported-arch.log" 2>&1; then
    fail "installer accepted unsupported architecture $_machine"
  else
    pass
  fi
done
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

(
  INIT=procd; TP_CONFIG_DIR="$TMP/router-panel"; TP_CONFIG_FILE=""
  apply_layout
  [ "$CONFIG_DIR" = "$TMP/router-panel" ] && [ "$CONFIG_FILE" = "$CONFIG_DIR/config.toml" ]
) || fail 'OpenWrt config directory override was ignored'

mkdir -p "$TMP/router-config"
(
  INIT=procd; TP_CONFIG_DIR=""; TP_CONFIG_FILE="$TMP/router-config/panel.toml"
  apply_layout
  [ "$CONFIG_DIR" = /etc/telemt-panel ] && [ "$CONFIG_FILE" = "$TP_CONFIG_FILE" ]
) || fail 'an external config file must not become the managed directory'

(
  INIT=entware; TP_CONFIG_DIR="$TMP/entware-panel"; TP_CONFIG_FILE="$TMP/router-config/entware.toml"
  apply_layout
  [ "$CONFIG_DIR" = "$TP_CONFIG_DIR" ] && [ "$CONFIG_FILE" = "$TP_CONFIG_FILE" ]
) || fail 'Entware defaults overrode the explicit paths'

for _file in relative.toml "$TMP/router-config/" "$TMP/router-config/../panel.toml" "$TMP/router-config/panel;id" "$TMP/missing-parent/panel.toml"; do
  if (INIT=procd; TP_CONFIG_FILE="$_file"; apply_layout) >/dev/null 2>&1; then
    fail "config path accepted $_file"
  fi
done

if (INIT=procd; TP_CONFIG_DIR=/etc/config; apply_layout) >/dev/null 2>&1; then
  fail 'accepted the shared UCI directory as the managed panel directory'
fi
if (INIT=procd; TP_CONFIG_DIR=/etc/telemt; apply_layout) >/dev/null 2>&1; then
  fail 'accepted the Telemt configuration directory as the managed panel directory'
fi

touch "$TMP/existing-procd-service"
if (
  INIT=procd; TP_CONFIG_FILE="$TMP/router-config/panel.toml"
  SERVICE_FILE="$TMP/existing-procd-service" validate_fresh_service_target
) >/dev/null 2>&1; then fail 'custom config path allowed replacing an existing procd service'; fi

printf '  procd_set_param command /usr/bin/telemt-panel --config "%s"\n' "$TMP/router-config/panel.toml" >"$TMP/existing-procd-service"
if (
  INIT=procd; PANEL_BIN=/usr/bin/telemt-panel; TP_CONFIG_FILE="$TMP/router-config/panel.toml"
  CONFIG_FILE="$TP_CONFIG_FILE" SERVICE_FILE="$TMP/existing-procd-service" retained_service_uses_config
); then pass; else fail 'retained procd service did not match a quoted config path'; fi
if (
  INIT=procd; PANEL_BIN=/usr/bin/telemt-panel; TP_CONFIG_FILE="$TMP/router-config/panel"
  CONFIG_FILE="$TP_CONFIG_FILE" SERVICE_FILE="$TMP/existing-procd-service" retained_service_uses_config
); then fail 'retained procd service accepted a config path prefix'; else pass; fi

ln -s "$TMP/router-config" "$TMP/router-config-alias"
printf '  procd_set_param command /usr/bin/telemt-panel --config %s\n' "$TMP/router-config-alias/panel.toml" >"$TMP/existing-procd-service"
if (
  INIT=procd; TP_CONFIG_FILE="$TMP/router-config-alias/panel.toml"
  apply_layout
  [ "$CONFIG_FILE" = "$TMP/router-config/panel.toml" ] &&
    SERVICE_FILE="$TMP/existing-procd-service" retained_service_uses_config
); then pass; else fail 'retained procd service did not recognize the requested config directory alias'; fi

# A retained service must bind the requested binary and config as complete
# arguments. A matching comment, path prefix or different instance is ambiguous.
for _init in systemd procd openrc sysvinit entware; do
  if (
    INIT="$_init"; PANEL_BIN="$TMP/managed-bin"; CONFIG_FILE="$TMP/selected.toml"
    SERVICE_FILE="$TMP/retained-service"; PANEL_LAUNCH_BIN="$PANEL_BIN.start"
    gen_service >"$SERVICE_FILE"
    retained_service_uses_config || exit 1
    sed "s|$CONFIG_FILE|$CONFIG_FILE.old|g" "$SERVICE_FILE" >"$SERVICE_FILE.new"
    mv "$SERVICE_FILE.new" "$SERVICE_FILE"
    printf '# --config %s\n' "$CONFIG_FILE" >>"$SERVICE_FILE"
    ! retained_service_uses_config
  ); then pass; else fail "$_init retained service config argument"; fi
done
if (
  INIT=procd; PANEL_BIN=/usr/bin/panel; CONFIG_FILE="$TMP/selected.toml"
  SERVICE_FILE="$TMP/retained-service"
  printf 'procd_set_param command %s --config %s\n' "$PANEL_BIN.old" "$CONFIG_FILE" >"$SERVICE_FILE"
  ! retained_service_uses_config
); then pass; else fail 'retained service accepted a binary prefix'; fi

if (
  PANEL_BIN=/usr/bin/panel; CONFIG_FILE="$TMP/selected.toml"
  cat >"$TMP/retained-service" <<EOF
procd_set_param command $PANEL_BIN --config $CONFIG_FILE
procd_set_param command $PANEL_BIN --config $CONFIG_FILE.other
EOF
  ! INIT=procd SERVICE_FILE="$TMP/retained-service" retained_service_uses_config
); then pass; else fail 'retained service accepted conflicting instances'; fi

# A missing --config cannot turn an existing installation into a fresh write.
if (
  : >"$TMP/occupied-unit"
  INIT=systemd SERVICE_FILE="$TMP/occupied-unit" validate_fresh_service_target
) >/dev/null 2>&1; then fail 'fresh systemd install accepted an occupied service'; else pass; fi

if (
  INIT=procd; TP_DATA_DIR="$TMP/router-config"; TP_TELEMT_CONFIG="$TMP/router-config/telemt.toml"
  apply_layout; TELEMT_BIN=/usr/bin/telemt
  validate_fresh_service_target
) >/dev/null 2>&1; then fail 'fresh installation accepted Telemt config directory as panel data'; else pass; fi

mkdir -p "$TMP/staged-panel-data" "$TMP/staged-other-app"
ln -s "$TMP/staged-other-app" "$TMP/staged-panel-data/staging"
if (
  INIT=procd; DATA_DIR="$TMP/staged-panel-data"; CONFIG_DIR="$TMP/fresh-config"
  PANEL_BIN="$TMP/fresh-panel"; SERVICE_FILE="$TMP/fresh-unit"; SUDOERS_FILE="$TMP/fresh-sudoers"
  validate_fresh_service_target
) >/dev/null 2>&1; then fail 'fresh install accepted a staging directory linked to another application'; else pass; fi

if (
  INIT=procd; TP_TELEMT_CONFIG="$TMP/router-config/telemt.toml"
  printf '[server.api]\nenabled = true\nlisten = "127.0.0.1:19092"\n' >"$TP_TELEMT_CONFIG"
  apply_layout
  detect_telemt
  [ "$TELEMT_URL_DETECTED" = http://127.0.0.1:19092 ]
); then pass; else fail 'Telemt TOML override was ignored'; fi

(
  OPENWRT_RELEASE="$TMP/openwrt_release"
  touch "$OPENWRT_RELEASE"
  PKG=opkg
  [ "$(install_hint install)" = 'opkg update && opkg install coreutils-install' ] || exit 1
  PKG=apk
  [ "$(install_hint timeout)" = 'apk add coreutils-timeout' ]
) || fail 'OpenWrt package hints do not name the required applets'

if (
  OPENWRT_RELEASE="$TMP/openwrt_release"
  id() { printf '0\n'; }
  has() {
    case "$1" in opkg|wget|tar|sha256sum|readlink) return 0 ;; *) return 1 ;; esac
  }
  check_prereqs
) >"$TMP/router-prereqs" 2>&1; then fail 'missing OpenWrt prerequisites accepted'; else pass; fi
for _package in coreutils-install coreutils-timeout coreutils-stat; do
  assert_contains 'missing router package reported' "$_package" "$TMP/router-prereqs"
done

if (
  TP_TLS_MODE=acme; TP_TLS_DOMAIN=UpPeR.ExAmPlE
  tr() {
    case "$1" in *'[:upper:]'*) return 1 ;; *) command tr "$@" ;; esac
  }
  ask_transport >/dev/null && [ "$TLS_DOMAIN" = upper.example ]
); then pass; else fail 'ACME domain needs optional BusyBox tr character classes'; fi

# An update keeps config.toml intact, so a full -> lite switch must be refused
# before installing a binary that cannot open the configured SQL store.
# TOML defaults are covered by the Go decoder; shell enforces profile policy.
BUILD_VARIANT=lite
STORE_DRIVER=sqlite
if (validate_existing_store_variant) >/dev/null 2>&1; then fail "lite accepted SQLite"; else pass; fi
STORE_DRIVER=memory
if (validate_existing_store_variant) >/dev/null 2>&1; then pass; else fail "lite rejected memory"; fi

# Destructive operations must refuse broad targets before any host mutation.
for _dir in / /etc /var /var/lib /tmp /home /home/admin /usr/local /www /overlay /rom /opt/var/lib /root relative /var/lib/../..; do
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
# Purge target safety is exercised with real parsed configs in install-remove-test.sh.
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
SERVICE_FILE=""
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

# The invoking sudo user may not be able to stat a protected config directory.
if (
  CONFIG_FILE="$TMP/privileged-only.toml"
  SUDO=privileged_probe
  privileged_probe() { [ "$*" = "test -e $CONFIG_FILE" ]; }
  detect_arch() { :; }; detect_libc() { :; }; detect_init() { :; }
  apply_layout() { :; }; detect_tools() { :; }; detect_telemt() { :; }
  choose_build_variant() { :; }
  detect_all
  [ "$EXISTING" = present ]
) >/dev/null 2>&1; then pass; else fail "protected config mistaken for fresh install"; fi

if (
  CONFIG_FILE="$TMP/dangling-config"
  ln -s "$TMP/missing-target" "$CONFIG_FILE"
  SUDO=""
  detect_arch() { :; }; detect_libc() { :; }; detect_init() { :; }
  apply_layout() { :; }; detect_tools() { :; }; detect_telemt() { :; }
  choose_build_variant() { :; }
  detect_all
  [ "$EXISTING" = present ]
) >/dev/null 2>&1; then pass; else fail "dangling config mistaken for fresh install"; fi

# Authorization goes through stdin, never the curl process arguments.
if (
  curl() {
    printf '%s\n' "$*" >"$TMP/probe-argv"
    cat >"$TMP/probe-stdin"
    printf '200'
  }
  [ "$(http_get http://localhost:9091 'Bearer PRIVATE_TOKEN')" = 200 ]
) >/dev/null 2>&1; then pass; else fail "authenticated curl probe failed"; fi
assert_not_contains "curl argv contains no token" PRIVATE_TOKEN "$TMP/probe-argv"
assert_contains "curl stdin carries header" 'Authorization: Bearer PRIVATE_TOKEN' "$TMP/probe-stdin"

if (
  curl() { printf 'called\n' >"$TMP/injected-request"; }
  _header=$(printf 'Bearer secret\r\nX-Injected: bad')
  [ "$(http_get http://localhost:9091 "$_header")" = 000 ]
  [ ! -e "$TMP/injected-request" ]
) >/dev/null 2>&1; then pass; else fail "multiline authorization accepted"; fi

if (
  has() { [ "$1" != curl ]; }
  wget() { printf 'called\n' >"$TMP/unsafe-wget"; }
  [ "$(check_telemt_api http://localhost:9091 'PRIVATE_TOKEN')" = needs-curl ]
  [ "$(http_get http://localhost:9091 'PRIVATE_TOKEN')" = 000 ]
  [ ! -e "$TMP/unsafe-wget" ]
) >/dev/null 2>&1; then pass; else fail "wget exposed authenticated header"; fi

if (
  has() { [ "$1" != curl ]; }
  wget() {
    case "$1" in --help) printf 'Usage: wget [-q] [-T sec] [-O file] URL\n'; return 1 ;; esac
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -S|-q) return 1 ;;
        -T) shift ;;
        -O) shift; probe_output=$1 ;;
        *) break ;;
      esac
      shift
    done
    case "$1" in
      */ok) printf '{"version":"fixture"}\n' >"$probe_output" ;;
      */unauthorized) printf 'HTTP error 401\n' >&2; return 8 ;;
      *) printf 'Connection failed\n' >&2; return 4 ;;
    esac
  }
  [ "$(http_get http://router/ok)" = 200 ] && grep -q fixture "$HTTP_BODY" &&
    [ "$(http_get http://router/unauthorized)" = 401 ] &&
    [ "$(http_get http://router/offline)" = 000 ]
); then pass; else fail 'wget probes failed with OpenWrt uclient-fetch options'; fi

# Remote releases require a verified checksum before extraction/installation.
for _tag in v1.0.0 v1.2.3-rc.4 v1.2.3-alpha-1+test.42; do
  if (REQ_VERSION="$_tag"; resolve_tag && [ "$INSTALLED_TAG" = "$_tag" ]); then pass; else fail "release tag rejected: $_tag"; fi
done
for _tag in v0.6.2 v2.0.0 v1.02.0 v1.0.0-01 v1.0.0/path; do
  if (REQ_VERSION="$_tag"; resolve_tag) >/dev/null 2>&1; then fail "unsupported release accepted: $_tag"; else pass; fi
done
if (
  REQ_VERSION=""
  http_get() { printf '{"tag_name":"v0.6.2"}\n' >"$HTTP_BODY"; printf 200; }
  resolve_tag
) >"$TMP/legacy-latest" 2>&1; then fail 'latest release resolved to a legacy binary'; else pass; fi
assert_contains 'legacy latest explains how to select a 1.x release' '--version' "$TMP/legacy-latest"

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

# Non-interactive input has the same password minimum as the interactive form.
if (
  ASSUME_YES=1; TP_ADMIN_PASSWORD=short
  ask_admin
) >"$TMP/short-password.log" 2>&1; then fail "short automated password accepted"; else pass; fi
if (
  ASSUME_YES=1; TP_ADMIN_PASSWORD=valid-password
  ask_admin
  [ "$ADMIN_PASS" = valid-password ]
) >/dev/null 2>&1; then pass; else fail "valid automated password rejected"; fi

# A SysV stop failure must preserve its PID file and never start a second daemon.
(
  RUN_AS=root
  gen_service_sysvinit
) | sed -e "s|^PIDFILE=.*|PIDFILE=\"$TMP/sysv.pid\"|" \
        -e "s|^LOGFILE=.*|LOGFILE=\"$TMP/sysv.log\"|" >"$TMP/sysv-service"
cat >"$TMP/bin/start-stop-daemon" <<'EOF'
#!/bin/sh
case "$1" in
  --stop) exit "$SYSV_STOP_STATUS" ;;
  --start) printf 'started\n' >>"$SYSV_STARTS" ;;
  *) exit 9 ;;
esac
EOF
chmod 0755 "$TMP/bin/start-stop-daemon"
printf '12345\n' >"$TMP/sysv.pid"
if SYSV_STOP_STATUS=2 SYSV_STARTS="$TMP/sysv-starts" sh "$TMP/sysv-service" restart >"$TMP/sysv-output" 2>&1; then
  fail "SysV restart hid stop failure"
else
  pass
fi
if [ -f "$TMP/sysv.pid" ] && [ ! -e "$TMP/sysv-starts" ]; then pass; else fail "SysV stop failure lost PID or started another daemon"; fi
if SYSV_STOP_STATUS=0 SYSV_STARTS="$TMP/sysv-starts" sh "$TMP/sysv-service" restart >"$TMP/sysv-output" 2>&1; then
  pass
else
  fail "SysV successful restart failed"
fi
if [ ! -e "$TMP/sysv.pid" ] && [ -s "$TMP/sysv-starts" ]; then pass; else fail "SysV successful stop/start was not completed"; fi

# Installing an OpenRC service is not successful if enabling autostart fails.
if (
  INIT=openrc
  gen_service() { printf 'synthetic service\n'; }
  write_root_file() { cat >/dev/null; }
  run() { return 1; }
  install_service
) >/dev/null 2>&1; then fail "OpenRC enable failure was hidden"; else pass; fi
if (
  INIT=openrc
  gen_service() { printf 'synthetic service\n'; }
  write_root_file() { cat >/dev/null; }
  run() { return 0; }
  install_service
) >/dev/null 2>&1; then pass; else fail "OpenRC enable success rejected"; fi
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

if sh "$HERE/install-worker-test.sh" >"$TMP/worker-test.log" 2>&1; then
  pass
else
  fail "worker installer fixture failed: $(tail -30 "$TMP/worker-test.log")"
fi

if sh "$HERE/install-entware-test.sh" >"$TMP/entware-test.log" 2>&1; then
  pass
else
  fail "Entware fixture failed: $(cat "$TMP/entware-test.log")"
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
