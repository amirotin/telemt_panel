#!/bin/sh
# Worker installer fixtures use temporary files only; never control host services.
# shellcheck disable=SC2034,SC2317,SC2329,SC1091,SC2015
set -eu
HERE=$(CDPATH="" cd -- "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
TP_SOURCED=1
. "$HERE/../install.sh"
trap 'rm -rf "$WORK"' EXIT INT TERM
L=en; COLOR=0; setup_colors
SUDO=""; DRY_RUN=0
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }
if (DRY_RUN=1; has() { [ "$1" != timeout ]; }; check_prereqs) >"$WORK/prereq.log" 2>&1; then
  fail 'fresh installer silently selects legacy behavior when timeout is unavailable'
fi
command -v detect_update_worker >/dev/null 2>&1 || fail 'installer does not detect the worker protocol before publication'
mkdir -p "$WORK/bin" "$WORK/data" "$WORK/config" "$WORK/services" "$WORK/sudoers" "$WORK/libexec"
PANEL_BIN="$WORK/bin/panel"; BIN_DIR="$WORK/bin"; DATA_DIR="$WORK/data"
CONFIG_DIR="$WORK/config"; CONFIG_FILE="$CONFIG_DIR/config.toml"
SERVICE_NAME=fixture-panel; TELEMT_SVC=fixture-telemt; TELEMT_BIN="$WORK/bin/telemt"
SERVICE_FILE="$WORK/services/panel.service"; SUDOERS_FILE="$WORK/sudoers/panel"
HELPER_FILE="$WORK/libexec/helper"; POLICY_FILE="$WORK/libexec/policy.json"
STAGED_BIN="$WORK/candidate"
cat >"$STAGED_BIN" <<'EOF'
#!/bin/sh
[ "$*" = 'update-worker --protocol' ] || exit 1
printf '%s\n' "${FIXTURE_PROTOCOL:-1}"
exit "${FIXTURE_EXIT:-0}"
EOF
chmod 0755 "$STAGED_BIN"
FIXTURE_PROTOCOL=1; export FIXTURE_PROTOCOL
detect_update_worker
[ "$WORKER_PROTOCOL" = 1 ] || fail 'supported protocol rejected'
FIXTURE_PROTOCOL=2; detect_update_worker
[ "$WORKER_PROTOCOL" = 0 ] || fail 'unknown protocol accepted'
FIXTURE_PROTOCOL=1; FIXTURE_EXIT=1; export FIXTURE_EXIT; detect_update_worker
[ "$WORKER_PROTOCOL" = 0 ] || fail 'failed protocol command accepted because it printed 1'
FIXTURE_EXIT=0
FIXTURE_PROTOCOL=1; detect_update_worker
printf 'PASS candidate protocol gate\n'

INIT=systemd; RUN_AS=user; SYSTEM_USER=fixture-user
worker_layout
gen_sudoers >"$WORK/grants"
for binary in "$PANEL_BIN" "$TELEMT_BIN"; do
  for destination in "$binary" "$binary.bak"; do
    grep -qF "$(command -v install) -m 0755 /dev/stdin $destination.tmp" "$WORK/grants" || fail 'missing stdin grant'
    grep -qF "$(command -v mv) -f $destination.tmp $destination" "$WORK/grants" || fail 'missing publication grant'
  done
  for suffix in .bak .tmp .bak.tmp; do
    grep -qF "$(command -v rm) -f $binary$suffix" "$WORK/grants" || fail 'missing exact cleanup grant'
  done
done

for action in start stop restart; do
  grep -qF "$(command -v systemctl) $action $SERVICE_NAME" "$WORK/grants" || fail 'missing panel service grant'
done
grep -qF "$(command -v systemctl) restart --no-block $SERVICE_NAME-updater" "$WORK/grants" || fail 'worker launch would wait for panel stop or lose a queued task'
if grep -Eq 'privileged|\*' "$WORK/grants"; then fail 'worker sudoers includes legacy helper or wildcard'; fi
gen_config >"$WORK/generated.toml"
if grep -Eq '^(helper_path|policy_path)' "$WORK/generated.toml"; then fail 'fresh worker config contains legacy helper bindings'; fi
gen_service >"$WORK/unit"
grep -qF "ExecStart=$PANEL_BIN.start --config $CONFIG_FILE" "$WORK/unit" || fail 'panel skips startup recovery'
gen_updater_service >"$WORK/updater-unit"
grep -qFx "User=$SYSTEM_USER" "$WORK/updater-unit" || fail 'worker UID differs from panel'
grep -qFx 'Type=oneshot' "$WORK/updater-unit" || fail 'worker is not a separate one-shot service'
if grep -Eq 'PartOf=|BindsTo=|ExecStop=|RemainAfterExit=' "$WORK/updater-unit"; then fail 'worker lifetime coupled to panel'; fi
RUN_AS=root; gen_updater_service >"$WORK/root-unit"
if grep -q '^User=' "$WORK/root-unit"; then fail 'root service unexpectedly changes user'; fi
grep -qFx 'Restart=on-failure' "$WORK/root-unit" || fail 'systemd worker cannot recover after SIGKILL'
grep -qFx 'TimeoutStopSec=185' "$WORK/root-unit" || fail 'systemd may kill the worker before its three-minute rollback finishes'
grep -qF "ExecStart=$PANEL_BIN.start --worker" "$WORK/root-unit" || fail 'systemd restart cannot fall back from a broken main executable'
INIT=procd; WORKER_STATE_OVERRIDE=""; worker_layout
[ "$WORKER_STATE_DIR" = "$CONFIG_DIR/updater" ] || fail 'OpenWrt recovery journal is stored on volatile /tmp'
gen_config >"$WORK/procd.toml"
grep -qFx "worker_state_dir = \"$CONFIG_DIR/updater\"" "$WORK/procd.toml" || fail 'OpenWrt config does not bind persistent worker state'
for INIT in openrc procd entware sysvinit; do
  worker_layout; gen_updater_service >"$WORK/$INIT-updater"
  sh -n "$WORK/$INIT-updater"
  grep -qF -- '--supervise-worker' "$WORK/$INIT-updater" || fail "$INIT worker has no independent crash supervisor"
  if grep -q respawn "$WORK/$INIT-updater"; then fail "$INIT worker respawns without a job"; fi
done
grep -qF 'procd_set_param term_timeout 185' "$WORK/procd-updater" || fail 'procd can kill a worker during its three-minute rollback'
INIT=procd; gen_service >"$WORK/procd-panel"
(
  . "$WORK/procd-panel"
  procd_running() { [ "$1" = "$SERVICE_NAME" ] && [ -f "$WORK/panel-stopping" ]; }
  touch "$WORK/panel-stopping"
  sleep() { rm -f "$WORK/panel-stopping"; }
  service_stopped || exit 1
  [ ! -e "$WORK/panel-stopping" ] || exit 1
  touch "$WORK/panel-stopping"
  sleep() { :; }
  if service_stopped; then exit 1; fi
) || fail 'generated procd stop must wait for exit or report a timeout'
printf 'PASS units, config and exact grants\n'

# A retained procd script may acknowledge stop before the instance has exited.
(
  INIT=procd; SERVICE_MANAGER=auto
  run() {
    case "$2" in
      stop) echo active >"$WORK/retained-state" ;;
      running) [ "$(cat "$WORK/retained-state")" = active ] ;;
    esac
  }
  sleep() { echo stopped >"$WORK/retained-state"; }
  stop_retained_panel
  [ "$(cat "$WORK/retained-state")" = stopped ]
) || fail 'update proceeded while the previous procd process was still running'

INIT=systemd; worker_layout
gen_panel_launcher >"$PANEL_BIN.start"; chmod 0755 "$PANEL_BIN.start"
cat >"$PANEL_BIN" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >>"$WORK/runtime-calls"
[ "\${1:-}" != update-worker ] || exit 0
EOF
chmod 0755 "$PANEL_BIN"
"$PANEL_BIN.start" --config "$CONFIG_FILE" 2>"$WORK/recovery-error"
grep -qFx "update-worker --recover --state-dir $DATA_DIR/updater" "$WORK/runtime-calls" || fail 'missing recovery invocation'
grep -qFx -- "--config $CONFIG_FILE" "$WORK/runtime-calls" || fail 'runtime arguments changed'
cp "$PANEL_BIN" "$PANEL_BIN.bak"
cat >"$PANEL_BIN.bak" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >>"$WORK/backup-calls"
cp "$WORK/good-main" "$PANEL_BIN"
chmod 0755 "$PANEL_BIN"
EOF
chmod 0755 "$PANEL_BIN.bak"
cp "$PANEL_BIN" "$WORK/good-main"
printf 'broken executable\n' >"$PANEL_BIN"
chmod 0644 "$PANEL_BIN"
"$PANEL_BIN.start" --config "$CONFIG_FILE" 2>"$WORK/recovery-error"
grep -qFx "update-worker --recover --state-dir $DATA_DIR/updater" "$WORK/backup-calls" || fail 'broken main skipped backup recovery'
printf 'PASS executable wrapper recovery and backup fallback\n'

# Exercise the generated SysV controls with an inert, private process. Keep
# the fixture's effective UID and PID file independent of the host service.
if command -v start-stop-daemon >/dev/null && [ -d /proc/self/fd ]; then
  (
    sysv_bin="$WORK/sysv-sleep"; cp "$(command -v sleep)" "$sysv_bin"
    sysv_user=$(id -un); SYSV_PIDFILE="$WORK/sysv.pid"
    PANEL_BIN="$sysv_bin" PANEL_LAUNCH_BIN="" SERVICE_NAME=fixture-sysv RUN_AS=root LOG_FILE="$WORK/sysv.log" gen_service_sysvinit | sed -e "s@^PIDFILE=.*@PIDFILE=\"$SYSV_PIDFILE\"@" \
      -e "s@^PANEL_USER=.*@PANEL_USER=\"$sysv_user\"@" -e 's/^DAEMON_ARGS=.*/DAEMON_ARGS="60"/' >"$WORK/sysv-service"
    sh "$WORK/sysv-service" start
    for _attempt in 1 2 3 4 5; do [ -s "$SYSV_PIDFILE" ] && break; sleep 1; done
    sysv_pid=$(cat "$SYSV_PIDFILE") || exit 1
    trap 'kill "$sysv_pid" 2>/dev/null || true' EXIT
    sh "$WORK/sysv-service" status
    sh "$WORK/sysv-service" start
    [ "$(cat "$SYSV_PIDFILE")" = "$sysv_pid" ] || exit 1
    cp "$(command -v sleep)" "$sysv_bin.new"; mv -f "$sysv_bin.new" "$sysv_bin"
    sh "$WORK/sysv-service" stop
    [ ! -e "$SYSV_PIDFILE" ] && [ ! -e "/proc/$sysv_pid/exe" ] || exit 1
  ) || fail 'generated SysV control did not retain process identity through replacement'
  printf 'PASS SysV process identity and repeated start\n'
fi

# The worker branch retries the failed child without invoking startup recovery.
rm -f "$PANEL_BIN.bak"
cat >"$PANEL_BIN" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >>"$WORK/worker-supervision"
if [ ! -f "$WORK/worker-first-failure" ]; then touch "$WORK/worker-first-failure"; exit 1; fi
exit 0
EOF
chmod 0755 "$PANEL_BIN"
"$PANEL_BIN.start" --supervise-worker
[ "$(wc -l <"$WORK/worker-supervision")" = 2 ] || fail 'worker supervisor did not retry once and stop after success'
if grep -q -- --recover "$WORK/worker-supervision"; then fail 'worker supervisor ran offline recovery'; fi
rm -f "$WORK/worker-supervision"
chmod 0644 "$PANEL_BIN"
cat >"$PANEL_BIN.bak" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >"$WORK/worker-backup"
exit 0
EOF
chmod 0755 "$PANEL_BIN.bak"
"$PANEL_BIN.start" --worker 2>"$WORK/worker-backup-error"
grep -qFx "update-worker --config $CONFIG_FILE --state-dir $DATA_DIR/updater" "$WORK/worker-backup" || fail 'worker branch did not invoke backup executor directly'
rm -f "$WORK/worker-backup"
printf '(\n' >"$PANEL_BIN"
chmod 0755 "$PANEL_BIN"
"$PANEL_BIN.start" --worker 2>"$WORK/worker-backup-error" || fail 'shell syntax failure from a corrupt executable skipped backup'
[ -f "$WORK/worker-backup" ] || fail 'corrupt executable did not invoke backup worker'
printf 'PASS supervisor retries failed worker and backup executor\n'

command -v acquire_worker_guard >/dev/null 2>&1 || fail 'installer does not serialize publication with the worker operation lock'
GUARD_PARSER="$WORK/idle-parser"
cat >"$GUARD_PARSER" <<'EOF'
#!/bin/sh
[ "$1 $2" = 'update-worker --check-idle' ] || exit 1
exit "${FIXTURE_BUSY:-0}"
EOF
chmod 0755 "$GUARD_PARSER"
STAGED_BIN="$GUARD_PARSER"; RUN_AS=user; SYSTEM_USER=$(id -un)
WORKER_PREVIOUS_STATE_DIR="$WORKER_STATE_DIR"
mkdir "$WORK/sleep-tools"
cat >"$WORK/sleep-tools/sleep" <<EOF
#!/bin/sh
case "\$1" in *.*) touch "$WORK/unsupported-sleep"; exit 1 ;; esac
exec "$(command -v sleep)" "\$@"
EOF
chmod 0755 "$WORK/sleep-tools/sleep"
PATH="$WORK/sleep-tools:$PATH" acquire_worker_guard
if flock -n "$WORKER_STATE_DIR/operation.lock" true; then fail 'another publisher entered while installer held its guard'; fi
release_worker_guard
[ ! -e "$WORK/unsupported-sleep" ] || fail 'worker guard requested fractional sleep on BusyBox'
flock -n "$WORKER_STATE_DIR/operation.lock" true || fail 'installer did not release operation lock'
ln -s "$WORKER_STATE_DIR" "$WORK/previous-state"
WORKER_PREVIOUS_STATE_DIR="$WORK/previous-state"
acquire_worker_guard || fail 'installer tried to acquire the same state directory lock twice through an alias'
release_worker_guard
WORKER_PREVIOUS_STATE_DIR="$WORKER_STATE_DIR"
FIXTURE_BUSY=1; export FIXTURE_BUSY
if acquire_worker_guard; then fail 'installer accepted a queued update after acquiring lock'; fi
release_worker_guard
FIXTURE_BUSY=0
flock -n "$WORKER_STATE_DIR/operation.lock" true || fail 'queued-task refusal leaked lock'
# shellcheck disable=SC2016
flock "$WORKER_STATE_DIR/operation.lock" sh -c 'touch "$1"; sleep 5' guard-race "$WORK/other-worker-locked" &
other_worker=$!
while [ ! -f "$WORK/other-worker-locked" ]; do sleep 0.05; done
if acquire_worker_guard; then fail 'installer accepted an executing worker'; fi
wait "$other_worker"
printf 'PASS installer excludes executing and queued workers\n'
(
  fixture_owner() {
    if [ "$1" = stat ] && [ "$2" = -c ] && [ "$3" = %u ]; then printf '0\n'; else "$@"; fi
  }
  RUN_AS=root; SUDO=fixture_owner
  layout="$WORK/openwrt-layout"; physical="$layout/tmp/lib/panel/updater"
  mkdir -p "$physical" "$layout/etc/updater"
  ln -s tmp "$layout/var"
  previous="$layout/var/lib/panel/updater"
  WORKER_PREVIOUS_STATE_DIR=$(openwrt_previous_journal "$previous" "$layout/var" "$layout/tmp") || exit 1
  [ "$WORKER_PREVIOUS_STATE_DIR" = "$physical" ] || exit 1
  WORKER_STATE_DIR="$layout/etc/updater" acquire_worker_guard || exit 1
  if flock -n "$previous/operation.lock" true; then exit 1; fi
  release_worker_guard
  chmod 0777 "$layout/tmp/lib"
  if openwrt_previous_journal "$previous" "$layout/var" "$layout/tmp"; then exit 1; fi
) || fail 'OpenWrt migration did not retain the protected physical journal lock'
printf 'PASS OpenWrt legacy journal under the system var alias\n'
cat >"$WORK/guard-holder.sh" <<EOF
#!/bin/sh
set -eu
TP_SOURCED=1
. "$HERE/../install.sh"
L=en; COLOR=0; setup_colors
RUN_AS=user; SYSTEM_USER="$(id -un)"; SUDO=""
TEMP_DIR="$WORK/orphan-temp"; mkdir -p "\$TEMP_DIR"
STAGED_BIN="$GUARD_PARSER"; WORKER_STATE_DIR="$WORK/orphan-state"
acquire_worker_guard
touch "$WORK/holder-ready"
exec sleep 30
EOF
sh "$WORK/guard-holder.sh" &
guard_holder=$!
while [ ! -f "$WORK/holder-ready" ]; do sleep 0.05; done
kill -KILL "$guard_holder"
wait "$guard_holder" 2>/dev/null || true
guard_wait=0
until flock -n "$WORK/orphan-state/operation.lock" true; do
  guard_wait=$((guard_wait + 1))
  [ "$guard_wait" -lt 100 ] || fail 'killed installer stranded its operation lock'
  sleep 0.05
done
printf 'PASS killed installer releases operation lock\n'

# The account owns registration and the lock. Keep the previous inode open
# across a normal publication to verify atomic replacement and file mode.
(
  umask 022
  worker_prepare_directory
  printf 'first\n' >"$WORK/registration-first"
  printf 'second\n' >"$WORK/registration-second"
  worker_write_registration "$WORK/registration-first"
  exec 8<"$WORKER_STATE_DIR/registration.json"
  worker_write_registration "$WORK/registration-second"
  IFS= read -r previous <&8
  exec 8<&-
  [ "$previous" = first ] && [ "$(cat "$WORKER_STATE_DIR/registration.json")" = second ]
  [ "$(stat -c %a "$WORKER_STATE_DIR/registration.json")" = 600 ]
  worker_copy_optional "$WORKER_STATE_DIR" registration.json "$WORK/registration-saved" 65536
  cmp "$WORK/registration-second" "$WORK/registration-saved"
) || fail 'registration update changed the open inode or failed to preserve owner access'
printf 'PASS owner-only atomic registration\n'

# Mock root ownership/publication while retaining the real transaction filesystem.
publish_root_file() { cp -p "$1" "$2"; chmod "$3" "$2"; }
ensure_privilege_directory() { mkdir -p "$1"; }
worker_reload_services() { printf reload >>"$WORK/reloads"; }
worker_prepare_directory() { mkdir -p "$DATA_DIR/updater"; }
for scenario in fresh success rollback publication-failure; do
  printf 'old service\n' >"$SERVICE_FILE"
  printf 'old helper\n' >"$HELPER_FILE"
  printf 'old policy\n' >"$POLICY_FILE"
  printf 'old sudoers\n' >"$SUDOERS_FILE"
  rm -f "$PANEL_BIN.start" "$WORKER_SERVICE_FILE" "$DATA_DIR/updater/registration.json"
  if [ "$scenario" = fresh ]; then rm -f "$HELPER_FILE" "$POLICY_FILE"; fi
  RUN_AS=root; WORKER_PROTOCOL=1; WORKER_REMOVE_LEGACY=1
  if [ "$scenario" = publication-failure ]; then
    publish_root_file() { [ "$2" != "$WORKER_SERVICE_FILE" ] || return 1; cp -p "$1" "$2"; chmod "$3" "$2"; }
    if install_update_worker pending; then fail 'publication failure reported success'; fi
    publish_root_file() { cp -p "$1" "$2"; chmod "$3" "$2"; }
    restore_worker_files
  else
    install_update_worker pending
    [ "$WORKER_PENDING" = 1 ] || fail 'worker publication is not transactional'
    [ -f "$DATA_DIR/updater/registration.json" ] || fail 'worker registration missing'
    [ ! -e "$SUDOERS_FILE" ] || fail 'direct profile retained unnecessary sudo grants'
    if [ "$scenario" != fresh ]; then [ -f "$HELPER_FILE" ] && [ -f "$POLICY_FILE" ] || fail 'legacy helper removed before candidate passed'; fi
    if [ "$scenario" = rollback ]; then restore_worker_files; else commit_worker_files; fi
  fi
  case "$scenario" in
    rollback|publication-failure)
      [ "$(cat "$SERVICE_FILE")" = 'old service' ] || fail 'old service not restored'
      [ "$(cat "$SUDOERS_FILE")" = 'old sudoers' ] || fail 'old grants not restored'
      [ "$(cat "$HELPER_FILE")" = 'old helper' ] || fail 'old helper changed during failed migration'
      [ ! -e "$PANEL_BIN.start" ] && [ ! -e "$WORKER_SERVICE_FILE" ] && [ ! -e "$DATA_DIR/updater/registration.json" ] || fail 'failed migration left new root files' ;;
    *) [ ! -e "$HELPER_FILE" ] && [ ! -e "$POLICY_FILE" ] || fail 'successful migration retained duplicate helper' ;;
  esac
  printf 'PASS worker transaction %s\n' "$scenario"
done

# Full installer migration: root file rollback must finish before old runtime
# restart, and successful migration must retain the service's custom settings.
# Exercise the policy writers shipped in release tags whenever history is
# available. Source archives can still exercise the current writers offline.
for n in 1 2 3 4; do
  if ! git -C "$HERE/.." show "refs/tags/v1.0.0-rc.$n:install.sh" >"$WORK/rc$n.sh" 2>/dev/null; then
    rm -f "$WORK/rc$n.sh"
  fi
done
for scenario in historical-rc1-systemd historical-rc1-openrc historical-rc1-sysvinit historical-rc2-systemd historical-rc2-openrc historical-rc2-sysvinit retained-rc1 migrate-user migrate-root migrate-procd migrate-procd-hook repeat-worker changed-worker-manual changed-worker-state changed-worker-grants changed-helper-service changed-helper-state fail-health fail-publication no-start old-protocol old-protocol-worker queued-worker shared-state-dir; do
  MIGRATION="$WORK/$scenario"
  MIGRATION_INIT=systemd
  case "$scenario" in migrate-procd*) MIGRATION_INIT=procd ;; historical-*-openrc) MIGRATION_INIT=openrc ;; historical-*-sysvinit) MIGRATION_INIT=sysvinit ;; esac
  export MIGRATION MIGRATION_INIT
  mkdir -p "$MIGRATION/bin" "$MIGRATION/data" "$MIGRATION/config" "$MIGRATION/services" "$MIGRATION/sudoers" "$MIGRATION/libexec" "$MIGRATION/tools"
  printf 'old-binary\n' >"$MIGRATION/bin/panel"; chmod 0751 "$MIGRATION/bin/panel"
  printf 'old helper\n' >"$MIGRATION/libexec/helper"
  printf 'old policy\n' >"$MIGRATION/libexec/policy.json"
  printf 'old grants\n' >"$MIGRATION/sudoers/panel"
  cat >"$MIGRATION/config/config.toml" <<EOF
data_dir = "$MIGRATION/data"
[updates]
panel_binary_path = "$MIGRATION/bin/panel"
telemt_binary_path = "$MIGRATION/bin/telemt"
[privileges]
mode = "auto"
helper_path = "$MIGRATION/libexec/helper"
policy_path = "$MIGRATION/libexec/policy.json"
EOF
  cat >"$MIGRATION/services/panel.service" <<EOF
[Service]
ExecStart=$MIGRATION/bin/panel --config $MIGRATION/config/config.toml
Environment=KEEP_THIS=unchanged
LimitNOFILE=12345
EOF
  if [ "$scenario" = changed-worker-manual ]; then
    sed 's/^mode = "auto"$/mode = "manual"/' "$MIGRATION/config/config.toml" >"$MIGRATION/manual.toml"
    mv "$MIGRATION/manual.toml" "$MIGRATION/config/config.toml"
    mkdir -p "$MIGRATION/data/updater"
    printf '%s\n' '{"version":1,"phase":"preparing"}' >"$MIGRATION/data/updater/state.json"
  fi
  if [ "$scenario" = shared-state-dir ]; then
    sed "/^\[updates\]/a worker_state_dir = \"$MIGRATION/config\"" "$MIGRATION/config/config.toml" >"$MIGRATION/shared-state.toml"
    mv "$MIGRATION/shared-state.toml" "$MIGRATION/config/config.toml"
    chmod 0750 "$MIGRATION/config"
  fi
  case "$scenario" in
    changed-worker-state|changed-helper-state)
      sed "/^\[updates\]/a worker_state_dir = \"$MIGRATION/other-state\"" "$MIGRATION/config/config.toml" >"$MIGRATION/proposed.toml"
      mv "$MIGRATION/proposed.toml" "$MIGRATION/config/config.toml" ;;
  esac
  cp -p "$MIGRATION/services/panel.service" "$MIGRATION/old-service"
  cp -p "$MIGRATION/config/config.toml" "$MIGRATION/old-config"
  if [ "$MIGRATION_INIT" = procd ]; then
    cat >"$MIGRATION/services/panel.service" <<EOF
#!/bin/sh
# Telemt Panel (generated by install.sh)
case "\${1:-}" in stop|restart) printf '%s\\n' "\$1" >>"$MIGRATION/service-calls"; exit 0 ;; running) exit 1 ;; esac
start_service() {
  procd_open_instance
  procd_set_param command $MIGRATION/bin/panel --config $MIGRATION/config/config.toml
  procd_close_instance
}
Environment=KEEP_THIS=unchanged
EOF
    if [ "$scenario" = migrate-procd-hook ]; then
      printf 'service_stopped() { echo custom-stop; }\n' >>"$MIGRATION/services/panel.service"
    fi
    chmod 0755 "$MIGRATION/services/panel.service"
  fi
  if [ "$scenario" = old-protocol-worker ]; then
    printf '# telemt-panel managed startup recovery\nexec "%s/bin/panel" "$@"\n' "$MIGRATION" >"$MIGRATION/bin/panel.start"
    printf 'ExecStart=%s/bin/panel update-worker --config %s/config/config.toml\n' "$MIGRATION" "$MIGRATION" >"$MIGRATION/services/fixture-panel-updater.service"
  fi
  cat >"$MIGRATION/report.json" <<EOF
{"format":"current","panel_binary_path":"$MIGRATION/bin/panel","telemt_binary_path":"$MIGRATION/bin/telemt","panel_service":"fixture-panel","telemt_service":"fixture-telemt","service_manager":"systemd","store_driver":"memory","listen":"127.0.0.1:8080","tls_mode":"http","data_dir":"$MIGRATION/data","privileges_helper_path":"$MIGRATION/libexec/helper","privileges_policy_path":"$MIGRATION/libexec/policy.json"}
EOF
  cat >"$MIGRATION/candidate" <<'EOF'
#!/bin/sh
case "$*" in
  version) printf 'telemt-panel 1.0.0 (full: memory)\n' ;;
  'update-worker --protocol') case "$SCENARIO" in old-protocol*) exit 1 ;; *) printf '1\n' ;; esac ;;
  'update-worker --check-idle '*) [ "$SCENARIO" != queued-worker ] ;;
  'config inspect '*)
    state_dir=$(awk -F '"' '/^worker_state_dir =/ {print $2}' "$4")
    if [ -n "$state_dir" ]; then sed "s#\"format\"#\"worker_state_dir\":\"$state_dir\",\"format\"#" "$MIGRATION/report.json"; else cat "$MIGRATION/report.json"; fi ;;
  'config check '*) exit 0 ;;
  'tls fingerprint '*) printf '%064d\n' 0 ;;
  'tls check '*)
    case "$*" in *--expect-fingerprint*) exit 0 ;; esac
    [ "$SCENARIO" != fail-health ] ;;
  *) exit 1 ;;
esac
EOF
  cat >"$MIGRATION/tools/systemctl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$MIGRATION/service-calls"
case "$*" in
  'show --property=FragmentPath '*) printf '%s\n' "$MIGRATION/services/panel.service" ;;
  'show --property=DynamicUser '*) printf 'no\n' ;;
  'show --property=User '*) case "$SCENARIO" in migrate-user|repeat-worker|changed-*|historical-*|retained-rc1) printf nobody ;; *) printf root ;; esac ;;
  'restart '* )
    case "$SCENARIO" in
      fail-health|fail-publication)
        if [ "$(cat "$MIGRATION/bin/panel")" = old-binary ]; then
          cmp "$MIGRATION/old-service" "$MIGRATION/services/panel.service" || exit 81
          [ "$(cat "$MIGRATION/sudoers/panel")" = 'old grants' ] || exit 82
          [ ! -e "$MIGRATION/bin/panel.start" ] || exit 83
          printf 'restored-before-restart\n' >>"$MIGRATION/order"
        fi ;;
    esac ;;
esac
EOF
  printf '#!/bin/sh\nexit 0\n' >"$MIGRATION/tools/rc-service"
  chmod 0755 "$MIGRATION/candidate" "$MIGRATION/tools/systemctl" "$MIGRATION/tools/rc-service"
  SCENARIO="$scenario"; export SCENARIO
  if (
    TP_SOURCED=1
    . "$HERE/../install.sh"
    L=en; COLOR=0; setup_colors; INIT="$MIGRATION_INIT"; ASSUME_YES=1; BUILD_VARIANT=full
    BINARY_FILE="$MIGRATION/candidate"; CONFIG_DIR="$MIGRATION/config"; CONFIG_FILE="$CONFIG_DIR/config.toml"
    SUDO=fixture_root; SUDOERS_FILE="$MIGRATION/sudoers/panel"
    PATH="$MIGRATION/tools:$PATH"
    apply_layout_from_answers() { BIN_DIR="$MIGRATION/bin"; SERVICE_FILE="$MIGRATION/services/panel.service"; }
    if [ "$INIT" = procd ]; then cmd_restart() { printf '%s restart' "$SERVICE_FILE"; }; fi
    inspect_removal_privileges() { return 0; }
    # Legacy behavior has its own dedicated authority/migration fixtures.
    prepare_systemd_privilege_upgrade() { return 0; }
    fixture_root() {
      case "$1:${2:-}:${3:-}" in
        sudo:-n:-ll) printf 'Sudoers entry:\n    RunAsUsers: root\n    Options: !authenticate\n    Commands:\n        /fixture\n'; return ;;
        sudo:-n:-l) shift 6; grep -Fxq "nobody ALL=(root) NOPASSWD: $*" "$SUDOERS_FILE"; return ;;
      esac
      if [ "$1" = "$HELPER_FILE" ] && [ "${2:-}" = privileged ]; then cat "$POLICY_FILE"; return; fi
      if [ "$1" = stat ] && [ "$2" = -c ] && [ "$3" = %u ]; then printf '0\n'; return; fi
      if [ "$1" = sudo ] && [ "$2" = -n ] && [ "$3" = -u ] && [ "$4" = nobody ] && [ "$5" = -- ]; then shift 5; "$@"; return; fi
      if [ "$1" = chown ] || [ "$1" = visudo ]; then return 0; fi
      if [ "$1" = install ] && [ "${4:-}" = -o ]; then
        fixture_mode="$3"; shift 7
        command install -m "$fixture_mode" "$@"; return
      fi
      "$@"
    }
    publish_root_file() {
      if [ "$SCENARIO" = fail-publication ] && [ "$2" = "$WORKER_SERVICE_FILE" ]; then return 1; fi
      cp -p "$1" "$2"; chmod "$3" "$2"
    }
    if [ "$SCENARIO" = no-start ]; then NO_START=1; fi
    case "$SCENARIO" in
      migrate-user|repeat-worker|changed-*|historical-*|retained-rc1)
        (
          case "$SCENARIO" in
            historical-rc1-*) historic_generation=1; historical_installer="${TP_TEST_RC1_INSTALLER:-$WORK/rc1.sh}" ;;
            historical-rc2-*) historic_generation=2; historical_installer="${TP_TEST_RC2_INSTALLER:-$WORK/rc2.sh}" ;;
            repeat-worker|changed-worker-*) historic_generation=4; historical_installer="${TP_TEST_RC4_INSTALLER:-$WORK/rc4.sh}" ;;
            retained-rc1) historic_generation=3; historical_installer="" ;;
            *) historic_generation=3; historical_installer="${TP_TEST_RC3_INSTALLER:-$WORK/rc3.sh}" ;;
          esac
          # Historical sources can be supplied from the release tags. The
          # ordinary offline run uses the matching local policy generators.
          # shellcheck disable=SC1090
          if [ -f "$historical_installer" ]; then TP_SOURCED=1 . "$historical_installer"; fi
          INIT="$MIGRATION_INIT"; RUN_AS=user; SYSTEM_USER=nobody; PANEL_BIN="$MIGRATION/bin/panel"; TELEMT_BIN="$MIGRATION/bin/telemt"
          SUDOERS_FILE="$MIGRATION/sudoers/panel"; CONFIG_DIR="$MIGRATION/config"; CONFIG_FILE="$CONFIG_DIR/config.toml"
          SERVICE_FILE="$MIGRATION/services/panel.service"; SERVICE_NAME=fixture-panel; TELEMT_SVC=fixture-telemt
          DATA_DIR="$MIGRATION/data"; HELPER_FILE="$MIGRATION/libexec/helper"; POLICY_FILE="$MIGRATION/libexec/policy.json"
          case "$SCENARIO" in
            repeat-worker|changed-worker-*)
              WORKER_PROTOCOL=1
              worker_layout
              gen_panel_launcher >"$PANEL_LAUNCH_BIN"
              gen_updater_service >"$WORKER_SERVICE_FILE"
              rm -f "$HELPER_FILE" "$POLICY_FILE"
              if [ "$SCENARIO" = changed-worker-grants ]; then TELEMT_BIN="$MIGRATION/bin/previous-telemt"; fi ;;
            changed-helper-service) TELEMT_SVC='previous-telemt' ;;
            retained-rc1) PRESERVE_RESTART_ONLY=1 ;;
            historical-*)
              rm -f "$HELPER_FILE" "$POLICY_FILE"
              chmod 0700 "$MIGRATION/libexec"
              LOG_FILE="$MIGRATION/panel.log"; TLS_MODE=http; LISTEN=127.0.0.1:8080
              gen_service >"$SERVICE_FILE"
              printf 'Environment=KEEP_THIS=unchanged\n' >>"$SERVICE_FILE" ;;
          esac
          if [ "$historic_generation" -le 2 ] && [ ! -f "$historical_installer" ]; then
            legacy_grant_commands print_legacy_grant "rc$historic_generation" >"$SUDOERS_FILE"
          else gen_sudoers >"$SUDOERS_FILE"; fi
          if [ "$SCENARIO" = repeat-worker ]; then
            { printf '\n# Local operator note\n'; sort -r "$SUDOERS_FILE"; } >"$MIGRATION/reordered"
            cp "$MIGRATION/reordered" "$SUDOERS_FILE"
          fi
        ) ;;
    esac
    case "$SCENARIO" in historical-*|retained-rc1)
      NO_START=1; HELPER_FILE="$MIGRATION/libexec/helper"; POLICY_FILE="$MIGRATION/libexec/policy.json"
      stop_retained_panel() { printf 'stop\n' >>"$MIGRATION/service-calls"; } ;;
    esac
    do_update_existing
  ) >"$MIGRATION/output" 2>&1; then migration_result=0; else migration_result=$?; fi
  case "$scenario" in
    changed-worker-manual|changed-worker-state|changed-worker-grants|changed-helper-service|changed-helper-state)
      [ "$migration_result" != 0 ] || fail "accepted mismatched administrative settings: $scenario"
      [ "$(cat "$MIGRATION/bin/panel")" = old-binary ] && [ ! -d "$MIGRATION/other-state" ] || fail 'rejected plan changed installation'
      if grep -Eq '^(stop|restart) ' "$MIGRATION/service-calls"; then fail 'rejected plan stopped the panel'; fi ;;
    historical-rc1-*|retained-rc1)
      [ "$migration_result" = 0 ] || { cat "$MIGRATION/output"; fail 'restart-only upgrade failed'; }
      cmp "$MIGRATION/bin/panel" "$MIGRATION/candidate" || fail 'new binary was not installed'
      [ -f "$MIGRATION/libexec/helper" ] && [ ! -e "$MIGRATION/bin/panel.start" ] || fail 'restart-only profile not retained'
      [ "$(grep -c ' privileged --policy ' "$MIGRATION/sudoers/panel")" = 7 ] || fail 'incomplete helper grants'
      [ "$(grep -c 'ALL=(root) NOPASSWD' "$MIGRATION/sudoers/panel")" = 9 ] || fail 'extra service controls published' ;;
    historical-rc2-*)
      [ "$migration_result" = 0 ] || { cat "$MIGRATION/output"; fail 'RC2 upgrade failed'; }
      cmp "$MIGRATION/bin/panel" "$MIGRATION/candidate" || fail 'new binary was not installed'
      [ -x "$MIGRATION/bin/panel.start" ] && [ -f "$MIGRATION/data/updater/registration.json" ] || fail 'RC2 worker not registered' ;;
    shared-state-dir)
      [ "$migration_result" != 0 ] || fail 'accepted the panel config directory as dedicated worker state'
      [ "$(stat -c %a "$MIGRATION/config")" = 750 ] || fail 'preflight changed config directory permissions'
      [ ! -e "$MIGRATION/config/operation.lock" ] || fail 'created a worker lock in the config directory'
      [ "$(cat "$MIGRATION/bin/panel")" = old-binary ] || fail 'state directory preflight replaced binary' ;;
    queued-worker)
      [ "$migration_result" != 0 ] || fail 'full installer accepted a queued worker'
      [ "$(cat "$MIGRATION/bin/panel")" = old-binary ] || fail 'queued worker refusal changed binary'
      [ "$(find "$MIGRATION/bin" -name '.telemt-panel-backup.*' | wc -l)" = 0 ] || fail 'installer backed up before checking queued work'
      if grep -Eq '^(stop|restart) ' "$MIGRATION/service-calls"; then fail 'installer stopped runtime despite a queued worker'; fi ;;
    old-protocol-worker)
      [ "$migration_result" != 0 ] || fail 'pre-worker candidate accepted with installed startup wrapper'
      [ "$(cat "$MIGRATION/bin/panel")" = old-binary ] || fail 'incompatible candidate changed live binary'
      cmp "$MIGRATION/old-service" "$MIGRATION/services/panel.service"
      [ ! -e "$MIGRATION/service-calls" ] || fail 'incompatible candidate controlled host services' ;;
    fail-health|fail-publication)
      [ "$migration_result" != 0 ] || fail "$scenario unexpectedly passed"
      [ "$(cat "$MIGRATION/bin/panel")" = old-binary ] || { cat "$MIGRATION/output"; fail 'binary not restored'; }
      grep -qFx restored-before-restart "$MIGRATION/order" || { cat "$MIGRATION/output"; fail 'old runtime restarted before restoring root files'; }
      [ -f "$MIGRATION/libexec/helper" ] && [ -f "$MIGRATION/libexec/policy.json" ] || fail 'failed migration removed legacy files' ;;
    old-protocol)
      [ "$migration_result" = 0 ] || { cat "$MIGRATION/output"; fail 'old protocol update failed'; }
      cmp "$MIGRATION/old-service" "$MIGRATION/services/panel.service"
      [ ! -e "$MIGRATION/bin/panel.start" ] && [ -f "$MIGRATION/libexec/helper" ] || fail 'old protocol altered worker installation' ;;
    *)
      [ "$migration_result" = 0 ] || { cat "$MIGRATION/output"; fail 'migration failed'; }
      grep -qFx 'Environment=KEEP_THIS=unchanged' "$MIGRATION/services/panel.service" || fail 'service overrides lost'
      if [ "$MIGRATION_INIT" = procd ]; then
        grep -qF "procd_set_param command $MIGRATION/bin/panel.start --config" "$MIGRATION/services/panel.service" || fail 'retained procd service lacks recovery wrapper'
        [ "$(grep -c 'service_stopped()' "$MIGRATION/services/panel.service")" = 1 ] || fail 'retained procd service must have one stop callback'
        if [ "$scenario" = migrate-procd-hook ]; then
          grep -qFx 'service_stopped() { echo custom-stop; }' "$MIGRATION/services/panel.service" || fail 'upgrade replaced a custom stop callback'
        fi
        [ -f "$MIGRATION/config/updater/registration.json" ] || fail 'procd registration is not persistent'
        grep -qFx "data_dir = \"$MIGRATION/data\"" "$MIGRATION/config/config.toml" || fail 'procd migration moved runtime data'
      else
        grep -qF "ExecStart=$MIGRATION/bin/panel.start --config" "$MIGRATION/services/panel.service" || fail 'retained service lacks recovery wrapper'
        [ -f "$MIGRATION/data/updater/registration.json" ] || fail 'registration missing'
      fi
      if [ "$scenario" = repeat-worker ]; then cmp "$MIGRATION/reordered" "$MIGRATION/sudoers/panel" || fail 'worker refresh rewrote an equivalent local policy'; fi
      if [ "$scenario" = no-start ]; then
        [ -f "$MIGRATION/libexec/helper" ] || fail 'unverified candidate deleted legacy helper'
      else
        [ ! -e "$MIGRATION/libexec/helper" ] && [ ! -e "$MIGRATION/libexec/policy.json" ] || fail 'verified migration retained helper'
      fi ;;
  esac
  if [ "$MIGRATION_INIT" = procd ]; then
    sed '/^worker_state_dir =/d' "$MIGRATION/config/config.toml" >"$MIGRATION/compare-config"
    cmp "$MIGRATION/old-config" "$MIGRATION/compare-config"
  else
    cmp "$MIGRATION/old-config" "$MIGRATION/config/config.toml"
  fi
  printf 'PASS full worker installer %s\n' "$scenario"
done

command -v remove_worker_files >/dev/null 2>&1 || fail 'uninstall leaves worker service and startup wrapper installed'
INIT=systemd; RUN_AS=root; SERVICE_NAME=fixture-panel
worker_layout
gen_updater_service >"$WORKER_SERVICE_FILE"
gen_panel_launcher >"$PANEL_LAUNCH_BIN"
mkdir -p "$WORKER_STATE_DIR"
gen_worker_registration >"$WORKER_STATE_DIR/registration.json"
remove_worker_files
[ ! -e "$WORKER_SERVICE_FILE" ] && [ ! -e "$PANEL_LAUNCH_BIN" ] && [ ! -e "$WORKER_STATE_DIR/registration.json" ] || fail 'worker installation cleanup incomplete'
printf 'PASS worker uninstall cleanup\n'
