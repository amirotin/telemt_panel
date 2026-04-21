#!/bin/sh
set -eu

# ── Constants ────────────────────────────────────────────────────────────────
REPO="amirotin/telemt_panel"
BINARY_NAME="telemt-panel"
SERVICE_NAME="telemt-panel"
SYSTEM_USER="telemt-panel"
BIN_DIR="/usr/local/bin"
PANEL_BINARY_PATH="${BIN_DIR}/${BINARY_NAME}"
CONFIG_DIR="/etc/telemt-panel"
CONFIG_FILE="${CONFIG_DIR}/config.toml"
DATA_DIR="/var/lib/telemt-panel"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
SUDOERS_FILE="/etc/sudoers.d/${SERVICE_NAME}"
LEGACY_BIN_DIR="/opt/bin/telemt"
LEGACY_CONFIG_DIR="/opt/etc/telemt-panel"

# Conventional installation paths with a non-root service user

# ── Utilities ────────────────────────────────────────────────────────────────
say()  { printf '[INFO]  %s\n' "$*"; }
die()  { printf '[ERROR] %s\n' "$*" >&2; exit 1; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

write_root() {
  $SUDO tee "$1" >/dev/null
}

TEMP_DIR=""
cleanup() {
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    rm -rf -- "$TEMP_DIR"
  fi
}
trap cleanup EXIT INT TERM

ensure_temp_dir() {
  if [ -z "$TEMP_DIR" ]; then
    TEMP_DIR=$(mktemp -d)
  fi
}

command_path() {
  _path=$(command -v "$1" 2>/dev/null || true)
  [ -n "$_path" ] || die "Required command '$1' not found. Install it and re-run."
  echo "$_path"
}

toml_value() {
  _file="$1"
  _section="$2"
  _key="$3"
  awk -v section="[$_section]" -v key="$_key" '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*\[[^[]/ {
      in_section = ($0 == section)
      next
    }
    in_section {
      line = $0
      sub(/[[:space:]]*#.*/, "", line)
      split(line, parts, "=")
      current_key = parts[1]
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", current_key)
      if (current_key == key) {
        value = substr(line, index(line, "=") + 1)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        gsub(/^"/, "", value)
        gsub(/"$/, "", value)
        print value
        exit
      }
    }
  ' "$_file"
}

# ── Architecture ─────────────────────────────────────────────────────────────
detect_arch() {
  _arch=$(uname -m)
  case "$_arch" in
    x86_64)  echo "x86_64"  ;;
    aarch64) echo "aarch64" ;;
    *)       die "Unsupported architecture: $_arch" ;;
  esac
}

# ── Telemt binary location ───────────────────────────────────────────────────
detect_telemt() {
  for _candidate in \
    "$BIN_DIR/telemt" \
    "$LEGACY_BIN_DIR/telemt" \
    /bin/telemt \
    /usr/bin/telemt \
    /usr/local/bin/telemt; do
    if [ -x "$_candidate" ]; then
      echo "$_candidate"
      return
    fi
  done
  echo "/bin/telemt"
}

# ── Install helper ───────────────────────────────────────────────────────────
install_binary() {
  _src="$1"
  _dst="$2"
  $SUDO install -m 0755 "$_src" "$_dst"
}

# ── Create system user ───────────────────────────────────────────────────────
create_system_user() {
  if id "$SYSTEM_USER" >/dev/null 2>&1; then
    say "System user '$SYSTEM_USER' already exists"
  else
    $SUDO useradd --system --shell /usr/sbin/nologin --home /nonexistent "$SYSTEM_USER" 2>/dev/null \
      || $SUDO adduser --system --shell /usr/sbin/nologin --home /nonexistent --disabled-password "$SYSTEM_USER" 2>/dev/null \
      || die "Failed to create system user '$SYSTEM_USER'. Create it manually and re-run."
    say "Created system user '$SYSTEM_USER'"
  fi
}

# ── Join telemt group for config access ─────────────────────────────────────
join_telemt_group() {
  _telemt_group=""
  # Detect telemt group from its config directory
  if [ -d "/etc/telemt" ]; then
    _telemt_group=$(stat -c '%G' /etc/telemt 2>/dev/null || true)
  fi
  # Fallback: check if 'telemt' group exists directly
  if [ -z "$_telemt_group" ] || [ "$_telemt_group" = "root" ]; then
    if command -v getent >/dev/null 2>&1; then
      getent group telemt >/dev/null 2>&1 && _telemt_group="telemt"
    elif grep -q "^telemt:" /etc/group 2>/dev/null; then
      _telemt_group="telemt"
    fi
  fi

  if [ -n "$_telemt_group" ] && [ "$_telemt_group" != "root" ]; then
    if id -nG "$SYSTEM_USER" 2>/dev/null | tr ' ' '\n' | grep -qx "$_telemt_group"; then
      say "User '$SYSTEM_USER' already in group '$_telemt_group'"
    else
      $SUDO usermod -aG "$_telemt_group" "$SYSTEM_USER" 2>/dev/null \
        || $SUDO adduser "$SYSTEM_USER" "$_telemt_group" 2>/dev/null \
        || { say "WARNING: Could not add '$SYSTEM_USER' to group '$_telemt_group' — add manually for telemt config access"; return; }
      say "Added '$SYSTEM_USER' to group '$_telemt_group' for telemt config access"
    fi
  else
    say "WARNING: telemt group not found — panel won't have access to telemt config"
    say "After installing telemt, re-run this installer or: sudo usermod -aG telemt $SYSTEM_USER"
  fi
}

# ── Check required commands ──────────────────────────────────────────────────
check_deps() {
  for _cmd in curl tar openssl systemctl; do
    command -v "$_cmd" >/dev/null 2>&1 || die "Required command '$_cmd' not found. Install it and re-run."
  done
  # sha256sum is optional (used for checksum verification)
  if ! command -v sha256sum >/dev/null 2>&1; then
    say "WARNING: sha256sum not found - checksum verification will be skipped"
  fi
}

# ── Set up directories ──────────────────────────────────────────────────────
setup_directories() {
  say "Setting up directories..."
  $SUDO mkdir -p "$BIN_DIR"
  $SUDO mkdir -p "$CONFIG_DIR"
  $SUDO mkdir -p "$DATA_DIR/staging"
  $SUDO chown "$SYSTEM_USER:$SYSTEM_USER" "$CONFIG_DIR"
  $SUDO chown "$SYSTEM_USER:$SYSTEM_USER" "$DATA_DIR"
  $SUDO chown "$SYSTEM_USER:$SYSTEM_USER" "$DATA_DIR/staging"
}

warn_legacy_install() {
  if [ -e "$LEGACY_BIN_DIR/$BINARY_NAME" ] || [ -d "$LEGACY_CONFIG_DIR" ]; then
    say "WARNING: Legacy /opt installation detected."
    say "This installer now uses $PANEL_BINARY_PATH and $CONFIG_FILE."
    say "Review and remove old /opt paths manually after confirming the new installation works."
  fi
}

install_sudoers_dropin() {
  _telemt_path="$1"
  _telemt_service="$2"

  [ -n "$_telemt_path" ] || _telemt_path=$(detect_telemt)
  [ -n "$_telemt_service" ] || _telemt_service="telemt"

  _cp=$(command_path cp)
  _mv=$(command_path mv)
  _chmod=$(command_path chmod)
  _rm=$(command_path rm)
  _systemctl=$(command_path systemctl)
  _visudo=$(command -v visudo 2>/dev/null || true)

  _panel_tmp="${BIN_DIR}/.${BINARY_NAME}.tmp"
  _panel_backup="${DATA_DIR}/staging/${BINARY_NAME}.bak"
  _telemt_name=$(basename "$_telemt_path")
  _telemt_dir=$(dirname "$_telemt_path")
  _telemt_tmp="${_telemt_dir}/.${_telemt_name}.tmp"
  _telemt_backup="${DATA_DIR}/staging/${_telemt_name}.bak"

  say "Installing sudoers drop-in for updater operations..."
  ensure_temp_dir
  _tmp="$TEMP_DIR/sudoers"
  cat >"$_tmp" <<EOF
$SYSTEM_USER ALL=(root) NOPASSWD: $_cp -f $PANEL_BINARY_PATH $_panel_backup
$SYSTEM_USER ALL=(root) NOPASSWD: $_cp -f $_telemt_path $_telemt_backup
$SYSTEM_USER ALL=(root) NOPASSWD: $_cp -f ${DATA_DIR}/staging/${BINARY_NAME} $_panel_tmp
$SYSTEM_USER ALL=(root) NOPASSWD: $_cp -f ${DATA_DIR}/staging/$_telemt_name $_telemt_tmp
$SYSTEM_USER ALL=(root) NOPASSWD: $_chmod 0755 $_panel_tmp
$SYSTEM_USER ALL=(root) NOPASSWD: $_chmod 0755 $_telemt_tmp
$SYSTEM_USER ALL=(root) NOPASSWD: $_mv -f $_panel_tmp $PANEL_BINARY_PATH
$SYSTEM_USER ALL=(root) NOPASSWD: $_mv -f $_telemt_tmp $_telemt_path
$SYSTEM_USER ALL=(root) NOPASSWD: $_rm -f $_panel_tmp
$SYSTEM_USER ALL=(root) NOPASSWD: $_rm -f $_telemt_tmp
$SYSTEM_USER ALL=(root) NOPASSWD: $_systemctl restart $SERVICE_NAME
$SYSTEM_USER ALL=(root) NOPASSWD: $_systemctl restart $_telemt_service
$SYSTEM_USER ALL=(root) NOPASSWD: $_systemctl start $SERVICE_NAME
$SYSTEM_USER ALL=(root) NOPASSWD: $_systemctl start $_telemt_service
EOF

  if [ -n "$_visudo" ]; then
    $SUDO "$_visudo" -cf "$_tmp" >/dev/null || die "Generated sudoers file is invalid"
  fi

  $SUDO mkdir -p "$(dirname "$SUDOERS_FILE")"
  $SUDO install -m 0440 "$_tmp" "$SUDOERS_FILE"
  say "Sudoers drop-in installed to $SUDOERS_FILE"
}

# ── Systemd unit (non-root service with sudoers-backed updates) ─────────────
generate_service() {
  cat <<EOF
[Unit]
Description=Telemt Panel
After=network.target

[Service]
Type=simple
User=$SYSTEM_USER
ExecStart=$PANEL_BINARY_PATH --config $CONFIG_FILE
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

# Hardening compatible with sudo-based updater operations
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$CONFIG_DIR $DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
}

# ── Read a value with default ────────────────────────────────────────────────
prompt() {
  _prompt="$1"
  _default="$2"
  if [ -n "$_default" ]; then
    printf '%s [%s]: ' "$_prompt" "$_default" >&2
  else
    printf '%s: ' "$_prompt" >&2
  fi
  read -r _val < /dev/tty
  echo "${_val:-$_default}"
}

prompt_secret() {
  _prompt="$1"
  printf '%s: ' "$_prompt" >&2
  stty -echo 2>/dev/null || true
  read -r _val < /dev/tty
  stty echo 2>/dev/null || true
  printf '\n' >&2
  echo "$_val"
}

# ── Usage ────────────────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Telemt Panel Installer (standard layout, non-root service)

Creates a dedicated system user '$SYSTEM_USER', installs into standard
Linux paths, and configures a narrow sudoers drop-in for updater actions.

Usage: $0 <command> [options]

Commands:
  install [version]   Install or update (default: latest release)
  uninstall           Remove binary, service, and sudoers drop-in
  purge               Remove everything including config, data, and user
  --help              Show this help

Examples:
  $0                  Install latest version
  $0 install v1.2.0  Install specific version
  $0 uninstall        Remove service and binary
  $0 purge            Remove everything

Directories:
  Binary:   $PANEL_BINARY_PATH
  Config:   $CONFIG_FILE
  Data:     $DATA_DIR/
  Service:  $SERVICE_FILE
  Sudoers:  $SUDOERS_FILE
EOF
}

# ═════════════════════════════════════════════════════════════════════════════
#  INSTALL
# ═════════════════════════════════════════════════════════════════════════════
do_install() {
  _version="${1:-}"

  printf '\n  Telemt Panel Installer (standard layout)\n\n'

  # ── Stage 0: Check dependencies ────────────────────────────────────────
  check_deps

  # ── Stage 1: Create system user and directories ─────────────────────────
  warn_legacy_install
  create_system_user
  join_telemt_group
  setup_directories

  # ── Stage 2: Detect architecture ─────────────────────────────────────────
  say "Detecting architecture..."
  ARCH=$(detect_arch)
  say "Architecture: $ARCH"

  # ── Stage 3: Download binary ─────────────────────────────────────────────
  if [ -n "$_version" ]; then
    TAG="$_version"
    say "Requested version: $TAG"
  else
    say "Fetching latest release..."
    TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
      | grep '"tag_name"' | cut -d'"' -f4) \
      || die "Could not determine latest release"
    [ -n "$TAG" ] || die "Could not determine latest release"
    say "Latest version: $TAG"
  fi

  TARBALL="telemt-panel-${ARCH}-linux-gnu.tar.gz"
  URL="https://github.com/$REPO/releases/download/$TAG/$TARBALL"
  ensure_temp_dir
  TMP_TAR="$TEMP_DIR/$TARBALL"

  say "Downloading $TARBALL..."
  curl -fSL "$URL" -o "$TMP_TAR" \
    || die "Download failed. Check that version $TAG exists."

  # Verify SHA256 checksum if available
  if command -v sha256sum >/dev/null 2>&1; then
    CHECKSUM_URL="https://github.com/$REPO/releases/download/$TAG/checksums.txt"
    TMP_CHECKSUMS="$TEMP_DIR/checksums.txt"
    if curl -fsSL "$CHECKSUM_URL" -o "$TMP_CHECKSUMS" 2>/dev/null; then
      say "Verifying SHA256 checksum..."
      EXPECTED=$(grep "$TARBALL" "$TMP_CHECKSUMS" | awk '{print $1}')
      if [ -n "$EXPECTED" ]; then
        ACTUAL=$(sha256sum "$TMP_TAR" | awk '{print $1}')
        if [ "$EXPECTED" != "$ACTUAL" ]; then
          die "Checksum mismatch! Expected: $EXPECTED, Got: $ACTUAL"
        fi
        say "Checksum OK"
      else
        say "WARNING: Checksum file found but no entry for $TARBALL - skipping verification"
      fi
    else
      say "WARNING: Checksum file not available - skipping verification"
    fi
  fi

  say "Extracting..."
  tar -xzf "$TMP_TAR" -C "$TEMP_DIR"
  EXTRACTED="$TEMP_DIR/telemt-panel-${ARCH}-linux"

  install_binary "$EXTRACTED" "$PANEL_BINARY_PATH"
  say "Installed $PANEL_BINARY_PATH ($TAG)"

  # ── Stage 4: Configure ──────────────────────────────────────────────────
  if [ -f "$CONFIG_FILE" ]; then
    say "Config already exists at $CONFIG_FILE - skipping"
    TELEMT_PATH=$(toml_value "$CONFIG_FILE" telemt binary_path || true)
    TELEMT_SERVICE=$(toml_value "$CONFIG_FILE" telemt service_name || true)
    [ -n "${TELEMT_PATH:-}" ] || TELEMT_PATH=$(detect_telemt)
    [ -n "${TELEMT_SERVICE:-}" ] || TELEMT_SERVICE="telemt"
    $SUDO chown "$SYSTEM_USER:$SYSTEM_USER" "$CONFIG_FILE"
    $SUDO chmod 755 "$CONFIG_FILE"
  else
    say "Setting up initial configuration..."
    echo ""

    TELEMT_URL=$(prompt "Telemt API URL" "http://127.0.0.1:9091")
    TELEMT_AUTH=$(prompt "Telemt API auth header (leave empty if none)" "")
    ADMIN_USER=$(prompt "Admin username" "admin")
    ADMIN_PASS=$(prompt_secret "Admin password")

    [ -n "$ADMIN_PASS" ] || die "Password cannot be empty"

    TELEMT_DETECTED=$(detect_telemt)
    TELEMT_PATH=$(prompt "Telemt binary path" "$TELEMT_DETECTED")

    TELEMT_SERVICE=$(prompt "Telemt systemd service name" "telemt")

    say "Generating password hash..."
    # Use printf to pipe password to avoid heredoc indentation issues
    PASS_HASH=$(printf '%s\n' "$ADMIN_PASS" | "$PANEL_BINARY_PATH" hash-password) \
      || die "Failed to generate password hash"

    JWT_SECRET=$(openssl rand -hex 32)

    # Build config with standard paths
    _cfg="listen = \"0.0.0.0:8080\"
data_dir = \"$DATA_DIR\"

[telemt]
url = \"$TELEMT_URL\""

    if [ -n "$TELEMT_AUTH" ]; then
      _cfg="$_cfg
auth_header = \"$TELEMT_AUTH\""
    fi

    _cfg="$_cfg
binary_path = \"$TELEMT_PATH\"
service_name = \"$TELEMT_SERVICE\"

[panel]
binary_path = \"$PANEL_BINARY_PATH\"
service_name = \"$SERVICE_NAME\"

[auth]
username = \"$ADMIN_USER\"
password_hash = \"$PASS_HASH\"
jwt_secret = \"$JWT_SECRET\"
session_ttl = \"24h\""

    printf '%s\n' "$_cfg" | write_root "$CONFIG_FILE"
    $SUDO chown "$SYSTEM_USER:$SYSTEM_USER" "$CONFIG_FILE"
    $SUDO chmod 640 "$CONFIG_FILE"
    say "Config saved to $CONFIG_FILE"
  fi

  install_sudoers_dropin "$TELEMT_PATH" "$TELEMT_SERVICE"

  # ── Stage 5: Install service ─────────────────────────────────────────────
  say "Installing systemd service..."
  generate_service | write_root "$SERVICE_FILE"
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable "$SERVICE_NAME"
  $SUDO systemctl start "$SERVICE_NAME"
  say "Service $SERVICE_NAME started and enabled"

  # ── Stage 6: Done ───────────────────────────────────────────────────────
  _ip=$(hostname -I 2>/dev/null | awk '{print $1}') || _ip="<server-ip>"
  printf '\n'
  say "Installation complete!"
  printf '\n'
  printf '  Panel URL:     http://%s:8080\n' "$_ip"
  printf '  System user:   %s\n' "$SYSTEM_USER"
  printf '  Binary:        %s\n' "$PANEL_BINARY_PATH"
  printf '  Config:        %s\n' "$CONFIG_FILE"
  printf '  Data:          %s\n' "$DATA_DIR"
  printf '  Sudoers:       %s\n' "$SUDOERS_FILE"
  printf '  Service:       %s\n' "$SERVICE_NAME"
  printf '\n'
  printf '  Useful commands:\n'
  printf '    sudo systemctl status  %s\n' "$SERVICE_NAME"
  printf '    sudo systemctl restart %s\n' "$SERVICE_NAME"
  printf '    sudo journalctl -u %s -f\n' "$SERVICE_NAME"
  printf '\n'
}

# ═════════════════════════════════════════════════════════════════════════════
#  UNINSTALL
# ═════════════════════════════════════════════════════════════════════════════
do_uninstall() {
  printf '\n  Telemt Panel Uninstaller\n\n'

  if [ -f "$SERVICE_FILE" ]; then
    say "Stopping service..."
    $SUDO systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    $SUDO systemctl disable "$SERVICE_NAME" 2>/dev/null || true
    $SUDO rm -f "$SERVICE_FILE"
    $SUDO systemctl daemon-reload
    say "Service removed"
  else
    say "Service not found - skipping"
  fi

  if [ -f "$BIN_DIR/$BINARY_NAME" ]; then
    $SUDO rm -f "$PANEL_BINARY_PATH"
    say "Binary removed"
  else
    say "Binary not found - skipping"
  fi

  if [ -f "$SUDOERS_FILE" ]; then
    $SUDO rm -f "$SUDOERS_FILE"
    say "Sudoers drop-in removed"
  fi

  printf '\n'
  say "Uninstall complete"
  say "Config ($CONFIG_DIR) and data ($DATA_DIR) were preserved"
  say "Run '$0 purge' to remove everything including user '$SYSTEM_USER'"
  printf '\n'
}

# ═════════════════════════════════════════════════════════════════════════════
#  PURGE
# ═════════════════════════════════════════════════════════════════════════════
do_purge() {
  do_uninstall

  say "Removing config and data..."
  $SUDO rm -rf "$CONFIG_DIR"
  $SUDO rm -rf "$DATA_DIR"

  # Remove system user if no other processes depend on it
  if id "$SYSTEM_USER" >/dev/null 2>&1; then
    say "Removing system user '$SYSTEM_USER'..."
    $SUDO userdel "$SYSTEM_USER" 2>/dev/null || true
  fi

  say "Purge complete - all telemt-panel files removed"
  printf '\n'
}

# ═════════════════════════════════════════════════════════════════════════════
#  MAIN
# ═════════════════════════════════════════════════════════════════════════════
_cmd="${1:-install}"
shift 2>/dev/null || true

case "$_cmd" in
  install)    do_install "${1:-}" ;;
  uninstall)  do_uninstall ;;
  purge)      do_purge ;;
  --help|-h)  usage ;;
  *)          usage; exit 1 ;;
esac
