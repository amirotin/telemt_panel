#!/bin/sh
# Behavioral tests for install.sh firewall assistance. All firewall executables
# are PATH-local stubs; this script never reads or changes the host firewall.
# shellcheck disable=SC2034,SC2016  # sourced globals and literal stub scripts
# shellcheck disable=SC2317  # test stubs are called indirectly by installer flows
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
INSTALLER="$HERE/../install.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

mkdir -p "$TMP/bin"
FIREWALL_MUTATIONS="$TMP/firewall-mutations"
export FIREWALL_MUTATIONS

printf '%s\n' '#!/bin/sh' \
  'case "$1" in' \
  '  status) printf "Status: %s\n" "${UFW_STATE:-inactive}" ;;' \
  '  allow)' \
  '    printf "ufw %s\n" "$*" >>"$FIREWALL_MUTATIONS"' \
  '    [ "${FIREWALL_FAIL:-}" != "$2" ]' \
  '    ;;' \
  'esac' >"$TMP/bin/ufw"

printf '%s\n' '#!/bin/sh' \
  'case "$1" in' \
  '  --state) printf "%s\n" "${FIREWALLD_STATE:-not running}" ;;' \
  '  --get-active-zones)' \
  '    [ "${FIREWALLD_ACTIVE_ZONES_FAIL:-0}" != 1 ] || exit 1' \
  '    printf "%b" "${FIREWALLD_ACTIVE_ZONES:-}"' \
  '    ;;' \
  '  --get-default-zone) printf "%s\n" "${FIREWALLD_DEFAULT_ZONE:-public}" ;;' \
  '  *)' \
  '    printf "firewall-cmd %s\n" "$*" >>"$FIREWALL_MUTATIONS"' \
  '    case "$*" in *"${FIREWALL_FAIL:-__never__}"*) exit 1 ;; esac' \
  '    ;;' \
  'esac' >"$TMP/bin/firewall-cmd"
chmod 0755 "$TMP/bin/ufw" "$TMP/bin/firewall-cmd"
PATH="$TMP/bin:$PATH"
export PATH

TP_SOURCED=1
# shellcheck disable=SC1090
. "$INSTALLER"
L=en
COLOR=0
SUDO=""

FAILED=0
PASSED=0

fail() {
  printf 'FAIL %s\n' "$*" >&2
  FAILED=$((FAILED + 1))
}

pass() {
  PASSED=$((PASSED + 1))
}

assert_eq() {
  if [ "$2" = "$3" ]; then
    pass
  else
    fail "$1: expected [$2], got [$3]"
  fi
}

assert_empty() {
  if [ ! -s "$2" ]; then
    pass
  else
    fail "$1: unexpected mutations: $(tr '\n' ';' <"$2")"
  fi
}

reset_firewalls() {
  : >"$FIREWALL_MUTATIONS"
  UFW_STATE=inactive
  FIREWALLD_STATE='not running'
  FIREWALLD_ACTIVE_ZONES=''
  FIREWALLD_ACTIVE_ZONES_FAIL=0
  FIREWALLD_DEFAULT_ZONE=public
  FIREWALL_FAIL=''
  export UFW_STATE FIREWALLD_STATE FIREWALLD_ACTIVE_ZONES FIREWALLD_ACTIVE_ZONES_FAIL
  export FIREWALLD_DEFAULT_ZONE FIREWALL_FAIL
}

# Missing consent and --yes must never mutate an active firewall.
reset_firewalls
UFW_STATE=active; export UFW_STATE
if (
  unset TP_OPEN_FIREWALL
  TLS_MODE=acme; LISTEN=0.0.0.0:8443; ASSUME_YES=1; DRY_RUN=0
  configure_firewall
) >"$TMP/no-consent.log" 2>&1; then pass; else fail "missing consent returned failure"; fi
assert_empty "--yes is not firewall consent" "$FIREWALL_MUTATIONS"

reset_firewalls
UFW_STATE=active; export UFW_STATE
if (
  TP_OPEN_FIREWALL=no
  TLS_MODE=acme; LISTEN=0.0.0.0:8443; ASSUME_YES=0; DRY_RUN=0
  configure_firewall
) >"$TMP/explicit-no.log" 2>&1; then pass; else fail "explicit firewall refusal returned failure"; fi
assert_empty "explicit firewall refusal opens no port" "$FIREWALL_MUTATIONS"

reset_firewalls
UFW_STATE=active; export UFW_STATE
if (
  unset TP_OPEN_FIREWALL
  TLS_MODE=http; LISTEN=0.0.0.0:8080; ASSUME_YES=0; DRY_RUN=0
  tty_available() { return 0; }
  confirm_yn() { [ "$1" = no ] || exit 9; return 1; }
  configure_firewall
) >"$TMP/default-no.log" 2>&1; then pass; else fail "interactive default No rejected"; fi
assert_empty "interactive default No opens no port" "$FIREWALL_MUTATIONS"

# Explicit consent opens exactly the public listener and ACME challenge ports.
reset_firewalls
UFW_STATE=active; export UFW_STATE
if (
  TP_OPEN_FIREWALL=yes
  TLS_MODE=acme; LISTEN=0.0.0.0:8443; ASSUME_YES=1; DRY_RUN=0
  configure_firewall
) >"$TMP/ufw.log" 2>&1; then pass; else fail "active UFW rejected"; fi
assert_eq "UFW exact ACME rules" 'ufw allow 8443/tcp
ufw allow 80/tcp' "$(cat "$FIREWALL_MUTATIONS")"

# Port 80 is not duplicated when it is already the primary listener.
reset_firewalls
UFW_STATE=active; export UFW_STATE
if (
  TP_OPEN_FIREWALL=yes
  TLS_MODE=acme; LISTEN=0.0.0.0:80; ASSUME_YES=1; DRY_RUN=0
  configure_firewall
) >/dev/null 2>&1; then pass; else fail "deduplicated ACME port rejected"; fi
assert_eq "ACME port deduplicated" 'ufw allow 80/tcp' "$(cat "$FIREWALL_MUTATIONS")"

# A loopback HTTP/reverse-proxy listener needs no host firewall rule.
reset_firewalls
UFW_STATE=active; export UFW_STATE
if (
  TP_OPEN_FIREWALL=yes
  TLS_MODE=http; LISTEN=127.0.0.1:8080; ASSUME_YES=1; DRY_RUN=0
  configure_firewall
) >/dev/null 2>&1; then pass; else fail "loopback HTTP rejected"; fi
assert_empty "loopback HTTP opens no port" "$FIREWALL_MUTATIONS"

for _loopback in \
  '[::1]:8080' \
  '[0::1]:8080' \
  '[::0001]:8080' \
  '[0:0:0:0:0:0:0:1]:8080' \
  '[0000:0000:0000:0000:0000:0000:0000:0001]:8080' \
  '[::0.0.0.1]:8080' \
  '[0:0:0:0:0:0:0.0.0.1]:8080' \
  '[::1%lo]:8080'
do
  reset_firewalls
  UFW_STATE=active; export UFW_STATE
  if (
    TP_OPEN_FIREWALL=yes
    TLS_MODE=http; LISTEN="$_loopback"; ASSUME_YES=1; DRY_RUN=0
    configure_firewall
  ) >/dev/null 2>&1; then pass; else fail "IPv6 loopback rejected: $_loopback"; fi
  assert_empty "IPv6 loopback opens no port: $_loopback" "$FIREWALL_MUTATIONS"
done

for _mapped_loopback in \
  '[::ffff:127.0.0.1]:8080' \
  '[::ffff:7f00:1]:8080' \
  '[0:0:0:0:0:ffff:7fff:ffff]:8080'
do
  reset_firewalls
  UFW_STATE=active; export UFW_STATE
  if (
    TP_OPEN_FIREWALL=yes
    TLS_MODE=http; LISTEN="$_mapped_loopback"; ASSUME_YES=1; DRY_RUN=0
    configure_firewall
  ) >/dev/null 2>&1; then pass; else fail "mapped loopback rejected: $_mapped_loopback"; fi
  assert_empty "mapped loopback opens no port: $_mapped_loopback" "$FIREWALL_MUTATIONS"
done

for _public_ipv6 in \
  '[1::]:8080' \
  '[2001:db8::1]:8080' \
  '[::ffff:192.0.2.1]:8080' \
  '[::ffff:c000:201]:8080'
do
  reset_firewalls
  UFW_STATE=active; export UFW_STATE
  if (
    TP_OPEN_FIREWALL=yes
    TLS_MODE=http; LISTEN="$_public_ipv6"; ASSUME_YES=1; DRY_RUN=0
    configure_firewall
  ) >/dev/null 2>&1; then pass; else fail "public IPv6 rejected: $_public_ipv6"; fi
  assert_eq "public IPv6 keeps firewall port: $_public_ipv6" 'ufw allow 8080/tcp' "$(cat "$FIREWALL_MUTATIONS")"
done

# Inactive or competing managers are never enabled or changed.
reset_firewalls
if (
  TP_OPEN_FIREWALL=yes
  TLS_MODE=certificate; LISTEN='[::]:8443'; ASSUME_YES=1; DRY_RUN=0
  configure_firewall
) >"$TMP/inactive.log" 2>&1; then pass; else fail "inactive managers returned failure"; fi
assert_empty "inactive managers skipped" "$FIREWALL_MUTATIONS"

reset_firewalls
UFW_STATE=active; FIREWALLD_STATE=running
FIREWALLD_ACTIVE_ZONES='public\n  interfaces: eth0\n'
export UFW_STATE FIREWALLD_STATE FIREWALLD_ACTIVE_ZONES
if (
  TP_OPEN_FIREWALL=yes
  TLS_MODE=certificate; LISTEN=0.0.0.0:8443; ASSUME_YES=1; DRY_RUN=0
  configure_firewall
) >"$TMP/ambiguous-manager.log" 2>&1; then pass; else fail "ambiguous managers returned failure"; fi
assert_empty "two active managers skipped" "$FIREWALL_MUTATIONS"

# firewalld gets both runtime and permanent rules in the sole active zone.
reset_firewalls
FIREWALLD_STATE=running
FIREWALLD_ACTIVE_ZONES='public\n  interfaces: eth0\n'
export FIREWALLD_STATE FIREWALLD_ACTIVE_ZONES
if (
  TP_OPEN_FIREWALL=yes
  TLS_MODE=acme; LISTEN=0.0.0.0:8443; ASSUME_YES=1; DRY_RUN=0
  configure_firewall
) >"$TMP/firewalld.log" 2>&1; then pass; else fail "active firewalld rejected"; fi
assert_eq "firewalld exact zone rules" 'firewall-cmd --zone=public --add-port=8443/tcp
firewall-cmd --permanent --zone=public --add-port=8443/tcp
firewall-cmd --zone=public --add-port=80/tcp
firewall-cmd --permanent --zone=public --add-port=80/tcp' "$(cat "$FIREWALL_MUTATIONS")"

# Multiple active zones are ambiguous, while no assignments use the default.
reset_firewalls
FIREWALLD_STATE=running
FIREWALLD_ACTIVE_ZONES='public\n  interfaces: eth0\ninternal\n  interfaces: eth1\n'
export FIREWALLD_STATE FIREWALLD_ACTIVE_ZONES
if (
  TP_OPEN_FIREWALL=yes
  TLS_MODE=http; LISTEN=0.0.0.0:8080; ASSUME_YES=1; DRY_RUN=0
  configure_firewall
) >"$TMP/multiple-zones.log" 2>&1; then pass; else fail "ambiguous zones returned failure"; fi
assert_empty "multiple firewalld zones skipped" "$FIREWALL_MUTATIONS"

reset_firewalls
FIREWALLD_STATE=running
FIREWALLD_ACTIVE_ZONES='docker\n  interfaces: docker0\n'
FIREWALLD_DEFAULT_ZONE=public
export FIREWALLD_STATE FIREWALLD_ACTIVE_ZONES FIREWALLD_DEFAULT_ZONE
if (
  TP_OPEN_FIREWALL=yes
  TLS_MODE=http; LISTEN=0.0.0.0:8080; ASSUME_YES=1; DRY_RUN=0
  configure_firewall
) >"$TMP/docker-zone.log" 2>&1; then pass; else fail "mismatched active/default zones returned failure"; fi
assert_empty "Docker-only active zone is ambiguous" "$FIREWALL_MUTATIONS"

# A failed active-zone query is not equivalent to a successful empty result.
reset_firewalls
FIREWALLD_STATE=running
FIREWALLD_ACTIVE_ZONES_FAIL=1
FIREWALLD_DEFAULT_ZONE=external
export FIREWALLD_STATE FIREWALLD_ACTIVE_ZONES_FAIL FIREWALLD_DEFAULT_ZONE
if (
  TP_OPEN_FIREWALL=yes
  TLS_MODE=http; LISTEN=0.0.0.0:8080; ASSUME_YES=1; DRY_RUN=0
  configure_firewall
) >"$TMP/zone-query-failure.log" 2>&1; then pass; else fail "failed zone query returned failure"; fi
assert_empty "failed firewalld zone query skips mutation" "$FIREWALL_MUTATIONS"

reset_firewalls
FIREWALLD_STATE=running
FIREWALLD_DEFAULT_ZONE=external
export FIREWALLD_STATE FIREWALLD_DEFAULT_ZONE
if (
  TP_OPEN_FIREWALL=yes
  TLS_MODE=http; LISTEN=0.0.0.0:8080; ASSUME_YES=1; DRY_RUN=0
  configure_firewall
) >/dev/null 2>&1; then pass; else fail "default firewalld zone rejected"; fi
assert_eq "firewalld default zone" 'firewall-cmd --zone=external --add-port=8080/tcp
firewall-cmd --permanent --zone=external --add-port=8080/tcp' "$(cat "$FIREWALL_MUTATIONS")"

# A command error is returned and is never labelled as full success.
reset_firewalls
UFW_STATE=active; FIREWALL_FAIL=8443/tcp
export UFW_STATE FIREWALL_FAIL
if (
  TP_OPEN_FIREWALL=yes
  TLS_MODE=certificate; LISTEN=0.0.0.0:8443; ASSUME_YES=1; DRY_RUN=0
  configure_firewall
) >"$TMP/failure.log" 2>&1; then
  fail "failed firewall command returned success"
else
  pass
fi
if grep -qF 'Firewall rules added successfully' "$TMP/failure.log"; then
  fail "failed firewall command reported success"
else
  pass
fi

# Dry-run prints the intended commands through run(), but invokes no mutation.
reset_firewalls
UFW_STATE=active; export UFW_STATE
if (
  TP_OPEN_FIREWALL=yes
  TLS_MODE=acme; LISTEN=0.0.0.0:8443; ASSUME_YES=1; DRY_RUN=1
  configure_firewall
) >"$TMP/dry-run.log" 2>&1; then pass; else fail "firewall dry-run rejected"; fi
assert_empty "dry-run performs no mutation" "$FIREWALL_MUTATIONS"

# Invalid automation input is rejected before detection or mutation.
reset_firewalls
UFW_STATE=active; export UFW_STATE
if (
  TP_OPEN_FIREWALL=YES
  TLS_MODE=http; LISTEN=0.0.0.0:8080; ASSUME_YES=1; DRY_RUN=0
  configure_firewall
) >"$TMP/invalid.log" 2>&1; then
  fail "invalid TP_OPEN_FIREWALL accepted"
else
  pass
fi
assert_empty "invalid consent performs no mutation" "$FIREWALL_MUTATIONS"

# Captured mutations cannot contain broad or destructive firewall operations.
reset_firewalls
UFW_STATE=active; export UFW_STATE
(
  TP_OPEN_FIREWALL=yes
  TLS_MODE=acme; LISTEN=0.0.0.0:8443; ASSUME_YES=1; DRY_RUN=0
  configure_firewall
) >/dev/null 2>&1
if grep -E 'delete|remove|enable|disable|reload|iptables|nft' "$FIREWALL_MUTATIONS" >/dev/null; then
  fail "unsafe firewall operation captured"
else
  pass
fi

# Each apply flow must place firewall configuration immediately before start.
if (
  FLOW_LOG="$TMP/install-flow"
  : >"$FLOW_LOG"
  require_tty() { :; }; blank() { :; }; confirm() { return 0; }
  check_prereqs() { :; }; detect_all() { EXISTING=none; INIT=systemd; }
  print_detection() { :; }; print_telemt_detection() { :; }
  collect_answers() { :; }; apply_layout_from_answers() { :; }
  print_summary() { :; }; step() { :; }; fetch_release() { :; }
  create_user() { :; }; setup_dirs() { :; }; hash_password() { :; }
  install_binary() { :; }; write_config() { :; }; install_sudoers() { :; }
  install_service() { :; }
  configure_firewall() { printf 'firewall\n' >>"$FLOW_LOG"; }
  start_service() { printf 'start\n' >>"$FLOW_LOG"; }
  print_done() { :; }
  do_install
  [ "$(cat "$FLOW_LOG")" = 'firewall
start' ]
) >"$TMP/install-flow.output" 2>&1; then pass; else fail "install flow firewall/start order"; fi

# Existing-installation updates keep the transport and never change firewall.
# Their transaction boundary is exercised by install-update-test.sh.

printf '%s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
