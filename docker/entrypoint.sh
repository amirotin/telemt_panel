#!/bin/sh
set -eu

# Diagnose the default profile without creating files or changing ownership.
if [ "${1:-}" = "--config" ] && [ "${2:-}" = "/etc/telemt-panel/config.toml" ]; then
    if [ ! -r /etc/telemt-panel/config.toml ] || [ ! -w /var/lib/telemt-panel ]; then
        echo "telemt-panel: config/data mounts are inaccessible to UID/GID $(id -u):$(id -g). Stop the container, back up these mounts and follow the offline ownership migration in docs/DOCKER.md; existing files were not changed." >&2
        exit 1
    fi
fi
exec /usr/local/bin/telemt-panel "$@"
