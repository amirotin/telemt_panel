#!/bin/sh
# Execute the real root CLI only inside a disposable user namespace/chroot.
set -eu
if ! command -v unshare >/dev/null || ! command -v chroot >/dev/null || ! unshare -Ur true 2>/dev/null; then
  printf '%s\n' 'PENDING: user namespace root/chroot rehearsal is unavailable'
  exit 77
fi
if [ "${1:-}" = --check ]; then
  printf '%s\n' 'AVAILABLE: disposable namespace root/chroot rehearsal prerequisites'
  exit 0
fi
BIN=${1:?provide a current static release binary}
BIN=$(CDPATH= cd -- "$(dirname "$BIN")" && pwd)/$(basename "$BIN")
"$BIN" version
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM
mkdir -p "$WORK/bin" "$WORK/libexec" "$WORK/etc/policy" "$WORK/var/staging/runs/panel" "$WORK/var/staging/runs/telemt"
cp "$BIN" "$WORK/bin/telemt-panel"
cp "$BIN" "$WORK/libexec/telemt-panel-privileged"
cp "$BIN" "$WORK/var/staging/runs/panel/bin"
printf 'new candidate marker' >>"$WORK/var/staging/runs/panel/bin"
printf 'old telemt' >"$WORK/bin/telemt"
printf 'new telemt' >"$WORK/var/staging/runs/telemt/bin"
chmod 0755 "$WORK/bin/telemt-panel" "$WORK/bin/telemt" "$WORK/libexec/telemt-panel-privileged"
printf '%s\n' '{"version":2,"helper_path":"/libexec/telemt-panel-privileged","staging_root":"/var/staging","binaries":{"panel":"/bin/telemt-panel","telemt":"/bin/telemt"}}' >"$WORK/etc/policy/policy.json"
chmod 0600 "$WORK/etc/policy/policy.json"
chmod 0700 "$WORK/etc/policy"
for target in panel telemt; do
  ORIGINAL=$(sha256sum "$WORK/bin/$(if [ "$target" = panel ]; then printf telemt-panel; else printf telemt; fi)" | awk '{print $1}')
  unshare -Ur chroot "$WORK" /libexec/telemt-panel-privileged privileged --policy /etc/policy/policy.json inspect
  for operation in backup install restore; do
    unshare -Ur chroot "$WORK" /libexec/telemt-panel-privileged privileged --policy /etc/policy/policy.json "$operation" "$target"
  done
  RESTORED=$(sha256sum "$WORK/bin/$(if [ "$target" = panel ]; then printf telemt-panel; else printf telemt; fi)" | awk '{print $1}')
  [ "$ORIGINAL" = "$RESTORED" ] || { printf '%s\n' "FAIL: $target restore bytes differ"; exit 1; }
done
ORIGINAL_PANEL=$(sha256sum "$WORK/bin/telemt-panel" | awk '{print $1}')
unshare -Ur chroot "$WORK" /libexec/telemt-panel-privileged privileged --policy /etc/policy/policy.json backup panel
printf 'invalid executable candidate\n' >"$WORK/var/staging/runs/panel/bin"
unshare -Ur chroot "$WORK" /libexec/telemt-panel-privileged privileged --policy /etc/policy/policy.json install panel
if ! unshare -Ur chroot "$WORK" /libexec/telemt-panel-privileged privileged --policy /etc/policy/policy.json restore panel; then
  printf '%s\n' 'FAIL: replacing the main panel removed the callable rollback helper'
  exit 1
fi
RESTORED_PANEL=$(sha256sum "$WORK/bin/telemt-panel" | awk '{print $1}')
[ "$ORIGINAL_PANEL" = "$RESTORED_PANEL" ] || { printf '%s\n' 'FAIL: panel rollback bytes differ'; exit 1; }
unshare -Ur chroot "$WORK" /bin/telemt-panel version
if [ -n "${2:-}" ]; then
  cp "$2" "$WORK/var/staging/runs/panel/bin"
  unshare -Ur chroot "$WORK" /libexec/telemt-panel-privileged privileged --policy /etc/policy/policy.json install panel
  if unshare -Ur chroot "$WORK" /bin/telemt-panel privileged --policy /etc/policy/policy.json inspect; then
    printf '%s\n' 'FAIL: older candidate unexpectedly implements privileged CLI'; exit 1
  fi
  unshare -Ur chroot "$WORK" /libexec/telemt-panel-privileged privileged --policy /etc/policy/policy.json restore panel
  RESTORED_PANEL=$(sha256sum "$WORK/bin/telemt-panel" | awk '{print $1}')
  [ "$ORIGINAL_PANEL" = "$RESTORED_PANEL" ] || { printf '%s\n' 'FAIL: older panel rollback bytes differ'; exit 1; }
  unshare -Ur chroot "$WORK" /bin/telemt-panel version
fi
printf '%s\n' 'PASS: real root CLI inspect/backup/install/restore in disposable namespace'
