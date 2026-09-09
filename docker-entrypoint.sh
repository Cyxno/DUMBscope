#!/bin/sh
# DUMBscope container entrypoint.
#
# Responsibilities:
# - ensure /config exists and is writable by the runtime user (PUID/PGID)
# - apply UMASK for files created inside /config only
# - step down from root to the runtime user and exec the server
#
# The entrypoint never touches any other host path — no recursive chowns
# outside /config, no permission changes to media or appdata mounts.
set -eu

PUID="${PUID:-99}"
PGID="${PGID:-100}"
UMASK="${UMASK:-0022}"
CONFIG_DIR="${DUMBSCOPE_CONFIG_DIR:-/config}"

mkdir -p "$CONFIG_DIR"

CURRENT_UID="$(id -u)"
if [ "$CURRENT_UID" = "0" ]; then
	# Restrict ownership changes to the config dir itself (no recursion into
	# anything else, even inside /config).
	chown "$PUID:$PGID" "$CONFIG_DIR" || true

	# Resolve the user/group names for su-exec without modifying the image.
	USER_NAME="$(getent passwd "$PUID" | cut -d: -f1 || true)"
	GROUP_NAME="$(getent group "$PGID" | cut -d: -f1 || true)"
	USER_NAME="${USER_NAME:-dumbscope}"
	GROUP_NAME="${GROUP_NAME:-dumbscope}"

	umask "$UMASK"
	exec su-exec "$PUID:$PGID" env DUMBSCOPE_CONFIG_DIR="$CONFIG_DIR" "$@"
fi

# Already non-root: just run.
umask "$UMASK"
exec "$@"
