#!/bin/sh
# Real protected-policy validation in a disposable user-namespace chroot.
# No host paths are deletion targets; service control alone is stubbed.
# Globals and service hooks are consumed by the sourced installer.
# shellcheck disable=SC2034,SC2317
set -eu
HERE=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
PARSER="${TP_TEST_BINARY:-$HERE/../telemt-panel}"
if [ ! -x "$PARSER" ]; then echo 'SKIP purge fixtures: set TP_TEST_BINARY'; exit 0; fi
if [ "${PURGE_INNER:-}" != 1 ]; then
  if ! unshare -Ur true 2>/dev/null; then echo 'SKIP purge fixtures: user namespaces unavailable'; exit 0; fi
  ROOTFS=$(mktemp -d)
  trap 'rm -rf "$ROOTFS"' EXIT INT TERM
  mkdir -p "$ROOTFS/bin" "$ROOTFS/src/scripts" "$ROOTFS/tmp" "$ROOTFS/dev"
  chmod 1777 "$ROOTFS/tmp"
  for tool in sh bash dirname basename cp chmod mkdir mktemp cat grep awk sed tr head rm mv ln readlink stat timeout install sha256sum id wc; do
    TOOL=$(command -v "$tool")
    cp -L "$TOOL" "$ROOTFS/bin/$tool"
    ldd "$TOOL" 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i ~ /^\//) print $i}' | while IFS= read -r dep; do
      mkdir -p "$ROOTFS$(dirname "$dep")"
      cp -L "$dep" "$ROOTFS$dep"
    done
  done
  cp "$PARSER" "$ROOTFS/bin/parser"
  cp "$HERE/../install.sh" "$ROOTFS/src/install.sh"
  cp "$0" "$ROOTFS/src/scripts/install-purge-test.sh"
  : >"$ROOTFS/dev/null"
  TMPDIR=/tmp PURGE_INNER=1 TP_TEST_BINARY=/bin/parser unshare -Ur chroot "$ROOTFS" /bin/"${TP_TEST_SHELL:-sh}" /src/scripts/install-purge-test.sh
  exit 0
fi

HASH=$(printf 'fixture-password\n' | "$PARSER" hash-password)
for scenario in purge uninstall after-uninstall custom custom-unrelated missing-policy tampered-policy mismatch helper-symlink policy-symlink parent-symlink unrelated writable-policy writable-helper changed dry overlap runtime-symlink; do
  CASE="/cases/$scenario"
  mkdir -p "$CASE/config" "$CASE/data" "$CASE/bin" "$CASE/telemt" "$CASE/protected" "$CASE/libexec" "$CASE/external" "$CASE/tools"
  printf 'panel binary\n' >"$CASE/bin/panel"
  printf 'telemt binary\n' >"$CASE/telemt/telemt"
  printf 'telemt config\n' >"$CASE/telemt/telemt.toml"
  printf 'sudoers\n' >"$CASE/sudoers"
  printf 'history\n' >"$CASE/data/history"
  printf 'external\n' >"$CASE/external/cert"
  printf 'shared executable\n' >"$CASE/libexec/unrelated"
  printf 'shared policy\n' >"$CASE/protected/unrelated"
  HELPER="$CASE/libexec/helper"
  POLICY="$CASE/protected/policy.json"
  case "$scenario" in
    custom|custom-unrelated) HELPER="$CASE/external/custom-helper"; POLICY="$CASE/external/custom-policy.json" ;;
    overlap) HELPER="$CASE/data/helper" ;;
    parent-symlink) ln -s "$CASE/libexec" "$CASE/alias"; HELPER="$CASE/alias/helper" ;;
  esac
  printf 'stable helper\n' >"$HELPER"
  chmod 0755 "$HELPER"
  printf '{"version":2,"helper_path":"%s","staging_root":"%s/data/staging","binaries":{"panel":"%s/bin/panel","telemt":"%s/telemt/telemt"}}\n' "$HELPER" "$CASE" "$CASE" "$CASE" >"$POLICY"
  chmod 0600 "$POLICY"
  printf "data_dir='%s/data'\nauth.username='admin'\nauth.password_hash='%s'\ntelemt.url='http://127.0.0.1:1'\nupdates.panel_binary_path='%s/bin/panel'\nupdates.telemt_binary_path='%s/telemt/telemt'\nhost.panel_service='custom-panel'\nprivileges.helper_path='%s'\nprivileges.policy_path='%s'\n" "$CASE" "$HASH" "$CASE" "$CASE" "$HELPER" "$POLICY" >"$CASE/config/config.toml"
  printf 'ExecStart=%s/bin/panel --config %s/config/config.toml\n' "$CASE" "$CASE" >"$CASE/unit"
  case "$scenario" in
    after-uninstall) rm "$CASE/bin/panel" "$CASE/unit" "$CASE/sudoers" ;;
    missing-policy|unrelated|custom-unrelated) rm "$POLICY" ;;
    tampered-policy) printf '{}\n' >"$POLICY" ;;
    mismatch) sed "s#$CASE/bin/panel#$CASE/bin/other#" "$POLICY" >"$POLICY.new"; mv "$POLICY.new" "$POLICY"; chmod 0600 "$POLICY" ;;
    helper-symlink) mv "$HELPER" "$CASE/external/helper"; ln -s "$CASE/external/helper" "$HELPER" ;;
    policy-symlink) mv "$POLICY" "$CASE/external/policy.json"; ln -s "$CASE/external/policy.json" "$POLICY" ;;
    writable-policy) chmod 0666 "$POLICY" ;;
    writable-helper) chmod 0777 "$HELPER" ;;
    runtime-symlink) mv "$HELPER" "$CASE/data/helper"; ln -s "$CASE/data/helper" "$HELPER" ;;
  esac
  cat >"$CASE/tools/systemctl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$CASE/calls"
EOF
  chmod 0755 "$CASE/tools/systemctl"
  export CASE SCENARIO="$scenario"
  if (
    TP_SOURCED=1
    # shellcheck disable=SC1091
    . "$HERE/../install.sh"
    L=en; COLOR=0; setup_colors
    CMD=purge
    if [ "$SCENARIO" = uninstall ]; then CMD=uninstall; fi
    CONFIG_DIR="$CASE/config"; CONFIG_FILE="$CONFIG_DIR/config.toml"
    SUDOERS_FILE="$CASE/sudoers"; TELEMT_CONFIG="$CASE/telemt/telemt.toml"
    BINARY_FILE="$PARSER"; ASSUME_YES=1
    if [ "$SCENARIO" = dry ]; then DRY_RUN=1; fi
    PATH="$CASE/tools:$PATH"
    require_tty() { :; }
    check_prereqs_quiet() { :; }
    detect_init() { INIT=systemd; }
    apply_layout() { PANEL_BIN="$CASE/bin/panel"; SERVICE_FILE="$CASE/unit"; }
    apply_layout_from_answers() { validate_service_names; BIN_DIR=$(dirname "$PANEL_BIN"); SERVICE_FILE="$CASE/unit"; }
    confirm_danger() {
      if [ "$SCENARIO" = changed ]; then printf 'changed\n' >>"$CASE/protected/policy.json"; fi
      return 0
    }
    if [ "$CMD" = uninstall ]; then do_uninstall; else do_purge; fi
  ) >"$CASE/output" 2>&1; then result=0; else result=$?; fi
  case "$scenario" in
    purge|after-uninstall|custom)
      if [ "$result" != 0 ] || [ -e "$HELPER" ] || [ -e "$POLICY" ]; then cat "$CASE/output"; echo "FAIL purge $scenario: owned helper/policy retained"; exit 1; fi
      [ ! -e "$CASE/config" ] && [ ! -e "$CASE/data" ] ;;
    uninstall)
      [ "$result" = 0 ] && [ -f "$HELPER" ] && [ -f "$POLICY" ] && [ -f "$CASE/config/config.toml" ] && [ -f "$CASE/data/history" ] && [ ! -e "$CASE/bin/panel" ] ;;
    changed|overlap|runtime-symlink)
      if [ "$result" = 0 ] || [ ! -f "$CASE/config/config.toml" ] || [ ! -f "$CASE/data/history" ] || [ ! -e "$HELPER" ]; then cat "$CASE/output"; echo "FAIL purge $scenario: unsafe removal proceeded"; exit 1; fi ;;
    dry)
      [ "$result" = 0 ] && [ -f "$HELPER" ] && [ -f "$POLICY" ] && [ -f "$CASE/config/config.toml" ] && [ ! -e "$CASE/calls" ] ;;
    *)
      if [ "$result" != 0 ] || [ ! -e "$HELPER" ] || [ -e "$CASE/config" ] || [ -e "$CASE/data" ]; then cat "$CASE/output"; echo "FAIL purge $scenario: ambiguous privilege files changed"; exit 1; fi
      grep -q 'retained' "$CASE/output" || { cat "$CASE/output"; echo "FAIL purge $scenario: no retention warning"; exit 1; }
      case "$scenario" in missing-policy|unrelated|custom-unrelated) ;; *) [ -e "$POLICY" ] ;; esac ;;
  esac
  [ -f "$CASE/libexec/unrelated" ] && [ -f "$CASE/protected/unrelated" ] && [ -f "$CASE/external/cert" ] && [ -f "$CASE/telemt/telemt" ] && [ -f "$CASE/telemt/telemt.toml" ]
  printf 'PASS purge %s\n' "$scenario"
done
