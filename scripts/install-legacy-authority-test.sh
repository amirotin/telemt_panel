#!/bin/sh
# Automatic migration must not expand the authority granted to the RC2 account.
# shellcheck disable=SC2034,SC2317,SC1090
set -eu
HERE=$(CDPATH="" cd -- "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
TP_SOURCED=1
. "${TP_TEST_INSTALLER:-$HERE/../install.sh}"
trap 'rm -rf "$TMP"' EXIT INT TERM
SUDO=policy_fixture; RUN_AS=user; SYSTEM_USER=retained-user
PANEL_BIN=/usr/local/bin/telemt-panel; TELEMT_BIN=/bin/telemt
DATA_DIR=/var/lib/telemt-panel; SERVICE_NAME=telemt-panel; TELEMT_SVC=telemt
INIT=systemd
CP=$(command -v cp); CHMOD=$(command -v chmod); MV=$(command -v mv); SYSTEMCTL=$(command -v systemctl)
# Literal permissions from the published RC2 installer. A command only succeeds
# if the old root policy actually grants its exact source, target and operation.
cat >"$TMP/allowed" <<EOF
sudo -n -l -U retained-user -- $CP -f /var/lib/telemt-panel/staging/runs/telemt/backup /bin/telemt.bak.tmp
sudo -n -l -U retained-user -- $CHMOD 0755 /bin/telemt.bak.tmp
sudo -n -l -U retained-user -- $MV -f /bin/telemt.bak.tmp /bin/telemt.bak
sudo -n -l -U retained-user -- $CP -f /var/lib/telemt-panel/staging/runs/telemt/bin /bin/telemt.tmp
sudo -n -l -U retained-user -- $CP -f /bin/telemt.bak /bin/telemt.tmp
sudo -n -l -U retained-user -- $CHMOD 0755 /bin/telemt.tmp
sudo -n -l -U retained-user -- $MV -f /bin/telemt.tmp /bin/telemt
sudo -n -l -U retained-user -- $CP -f /var/lib/telemt-panel/staging/runs/panel/backup /usr/local/bin/telemt-panel.bak.tmp
sudo -n -l -U retained-user -- $CHMOD 0755 /usr/local/bin/telemt-panel.bak.tmp
sudo -n -l -U retained-user -- $MV -f /usr/local/bin/telemt-panel.bak.tmp /usr/local/bin/telemt-panel.bak
sudo -n -l -U retained-user -- $CP -f /var/lib/telemt-panel/staging/runs/panel/bin /usr/local/bin/telemt-panel.tmp
sudo -n -l -U retained-user -- $CP -f /usr/local/bin/telemt-panel.bak /usr/local/bin/telemt-panel.tmp
sudo -n -l -U retained-user -- $CHMOD 0755 /usr/local/bin/telemt-panel.tmp
sudo -n -l -U retained-user -- $MV -f /usr/local/bin/telemt-panel.tmp /usr/local/bin/telemt-panel
sudo -n -l -U retained-user -- $SYSTEMCTL restart telemt
sudo -n -l -U retained-user -- $SYSTEMCTL restart telemt-panel
sudo -n -l -U retained-user -- $SYSTEMCTL start telemt
sudo -n -l -U retained-user -- $SYSTEMCTL stop telemt
EOF
cat >"$TMP/listing" <<'EOF'
User retained-user may run the following commands on fixture:

Sudoers entry:
    RunAsUsers: root
    Options: !authenticate
    Commands:
        /usr/bin/cp -f /var/lib/telemt-panel/staging/runs/telemt/bin /bin/telemt.tmp
EOF
policy_fixture() {
  if [ "$*" = 'sudo -n -ll -U retained-user' ]; then cat "$TMP/listing"; return; fi
  printf '%s\n' "$*" >>"$TMP/probes"
  grep -Fxq -- "$*" "$TMP/allowed"
}
verify_legacy_privilege_authority
cmp "$TMP/allowed" "$TMP/probes"
printf '%s\n' 'PASS: automatic migration proves every existing RC2 authority without executing commands'
for changed in telemt panel data user service; do
  if (
    case "$changed" in
      telemt) TELEMT_BIN=/usr/local/bin/other-daemon ;;
      panel) PANEL_BIN=/usr/local/bin/other-panel ;;
      data) DATA_DIR=/var/lib/other-instance ;;
      user) SYSTEM_USER=another-user ;;
      service) TELEMT_SVC=other-service ;;
    esac
    verify_legacy_privilege_authority
  ); then
    printf 'FAIL: ungranted %s binding accepted\n' "$changed" >&2; exit 1
  fi
  printf 'PASS: ungranted %s binding rejected\n' "$changed"
done
for policy_kind in password-required extra-restriction custom-group custom-cwd missing-commands unknown-format; do
  cp "$TMP/listing" "$TMP/original-listing"
  case "$policy_kind" in
    password-required) sed 's/!authenticate/authenticate/' "$TMP/original-listing" >"$TMP/listing" ;;
    extra-restriction) sed 's/!authenticate/!authenticate, noexec/' "$TMP/original-listing" >"$TMP/listing" ;;
    custom-group) sed '/RunAsUsers:/a\    RunAsGroups: restricted' "$TMP/original-listing" >"$TMP/listing" ;;
    custom-cwd) sed '/RunAsUsers:/a\    Cwd: /restricted' "$TMP/original-listing" >"$TMP/listing" ;;
    missing-commands) sed '/Commands:/,$d' "$TMP/original-listing" >"$TMP/listing" ;;
    unknown-format) printf 'unrecognized sudo policy output\n' >"$TMP/listing" ;;
  esac
  : >"$TMP/probes"
  if verify_legacy_privilege_authority; then
    printf 'FAIL: custom %s policy was treated as standard RC2 NOPASSWD\n' "$policy_kind" >&2; exit 1
  fi
  [ ! -s "$TMP/probes" ]
  mv "$TMP/original-listing" "$TMP/listing"
  printf 'PASS: %s policy requires explicit repair\n' "$policy_kind"
done
RUN_AS=root
: >"$TMP/probes"
verify_legacy_privilege_authority
[ ! -s "$TMP/probes" ]
printf '%s\n' 'PASS: root service needs no sudo migration authority'
